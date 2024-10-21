require('dotenv').config(); // Importar e configurar o dotenv

const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const geolib = require('geolib');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar o diretório de arquivos GPX
const gpxDirectory = path.join(__dirname, 'arquivos-gpx');

// Configuração e conexão com o banco de dados SQLite
const dbPath = path.join(__dirname, 'rotas.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar no banco de dados SQLite:', err);
        return;
    }
    console.log('Conectado ao banco de dados SQLite');

    // Criar a tabela caso não exista
    db.run(`
        CREATE TABLE IF NOT EXISTS rotas_gps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rota_id TEXT,
            empresa TEXT,
            data_hora TEXT,
            turno TEXT,
            quilometragem REAL,
            tempo_de_rota REAL,
            arquivo_gpx TEXT
        )
    `, (err) => {
        if (err) {
            console.error('Erro ao criar a tabela:', err);
        }
    });
});

// Lista de feriados fixos no formato 'MM-DD'
const feriadosFixos = [
    '01-01', // Ano Novo
    '04-21', // Tiradentes
    '05-01', // Dia do Trabalhador
    '09-07', // Independência do Brasil
    '10-12', // Nossa Senhora Aparecida
    '11-02', // Finados
    '11-15', // Proclamação da República
    '12-25'  // Natal
];

// Função para calcular a data da Páscoa
function calcularPascoa(ano) {
    const a = ano % 19;
    const b = Math.floor(ano / 100);
    const c = ano % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31);
    const dia = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(ano, mes - 1, dia);
}

// Função para obter a lista completa de feriados (fixos + móveis)
function obterFeriados(ano) {
    const feriados = [...feriadosFixos.map(d => `${ano}-${d}`)];

    // Feriados móveis
    const pascoa = calcularPascoa(ano);
    const carnaval = new Date(pascoa);
    carnaval.setDate(carnaval.getDate() - 47); // Carnaval é 47 dias antes da Páscoa
    const corpusChristi = new Date(pascoa);
    corpusChristi.setDate(corpusChristi.getDate() + 60); // Corpus Christi é 60 dias após a Páscoa

    // Adicionar feriados móveis à lista
    feriados.push(
        pascoa.toISOString().slice(0, 10),
        carnaval.toISOString().slice(0, 10),
        corpusChristi.toISOString().slice(0, 10)
    );

    return feriados;
}

function processGpxFiles() {
    fs.readdir(gpxDirectory, (err, files) => {
        if (err) {
            console.error('Erro ao ler o diretório:', err);
            return;
        }

        files.forEach(file => {
            if (path.extname(file) === '.gpx') {
                const [idRota, empresa, turnoComExtensao] = file.split('-');
                const turno = turnoComExtensao.replace('.gpx', '');

                // Mapear o turno para o horário correspondente (segunda a sexta)
                const horarios = {
                    'manha': '0 7 * * 1-5',
                    'meio': '0 13 * * 1-5',
                    'tarde': '41 17 * * 1-5',
                    'noite': '0 19 * * 1-5',
                    'madrugada': '45 23 * * 1-5'
                };

                const cronExpression = horarios[turno];

                if (cronExpression) {
                    scheduleTask(cronExpression, path.join(gpxDirectory, file), {
                        idRota,
                        empresa,
                        turno
                    });
                } else {
                    console.error(`Turno desconhecido no arquivo: ${file}`);
                }
            }
        });
    });
}

function scheduleTask(cronExpression, filePath, { idRota, empresa, turno }) {
    cron.schedule(cronExpression, () => {
        const hoje = new Date();
        const anoAtual = hoje.getFullYear();
        const dataHoje = hoje.toISOString().slice(0, 10); // Formato 'YYYY-MM-DD'

        const feriados = obterFeriados(anoAtual);

        // Verificar se hoje é um feriado
        if (feriados.includes(dataHoje)) {
            console.log(`Hoje é feriado (${dataHoje}). A tarefa não será executada.`);
            return;
        }

        console.log(`Enviando dados do arquivo ${filePath} no turno ${turno}`);
        sendDataToDatabase(filePath, { idRota, empresa, turno });
    });
}

function sendDataToDatabase(filePath, { idRota, empresa, turno }) {
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Erro ao ler o arquivo GPX:', err);
            return;
        }

        const xmlParser = new XMLParser({ ignoreAttributes: false });
        const xmlBuilder = new XMLBuilder({ ignoreAttributes: false });
        const jsonObj = xmlParser.parse(data);

        const track = jsonObj?.gpx?.trk;
        if (!track) {
            console.error('Track não encontrado no arquivo GPX.');
            return;
        }

        let quilometragemOriginal = 0;
        let tempoRotaOriginal = null;
        let quilometragem = 0;
        let tempoRota = null;

        try {
            const trackSegments = Array.isArray(track.trkseg) ? track.trkseg : [track.trkseg];
            const trackPoints = trackSegments.flatMap(seg => Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt]);

            // Calcular a quilometragem e tempo de rota originais
            for (let i = 0; i < trackPoints.length - 1; i++) {
                const pontoA = trackPoints[i];
                const pontoB = trackPoints[i + 1];

                const distancia = geolib.getDistance(
                    { latitude: parseFloat(pontoA['@_lat']), longitude: parseFloat(pontoA['@_lon']) },
                    { latitude: parseFloat(pontoB['@_lat']), longitude: parseFloat(pontoB['@_lon']) }
                );

                quilometragemOriginal += distancia;
            }
            quilometragemOriginal = quilometragemOriginal / 1000;

            const timesOriginal = trackPoints
                .map(point => new Date(point.time))
                .filter(time => !isNaN(time));

            if (timesOriginal.length > 1) {
                const timeStampsOriginal = timesOriginal.map(time => time.getTime());
                tempoRotaOriginal = (Math.max(...timeStampsOriginal) - Math.min(...timeStampsOriginal)) / 1000;
            } else {
                tempoRotaOriginal = null;
            }

            const coordenadaVariacao = 0.00002;
            for (let i = 0; i < trackPoints.length; i++) {
                const point = trackPoints[i];

                const latVariacao = (Math.random() * (2 * coordenadaVariacao)) - coordenadaVariacao;
                const lonVariacao = (Math.random() * (2 * coordenadaVariacao)) - coordenadaVariacao;

                point['@_lat'] = (parseFloat(point['@_lat']) + latVariacao).toFixed(6);
                point['@_lon'] = (parseFloat(point['@_lon']) + lonVariacao).toFixed(6);
            }

            for (let i = 0; i < trackPoints.length - 1; i++) {
                const pontoA = trackPoints[i];
                const pontoB = trackPoints[i + 1];

                const distancia = geolib.getDistance(
                    { latitude: parseFloat(pontoA['@_lat']), longitude: parseFloat(pontoA['@_lon']) },
                    { latitude: parseFloat(pontoB['@_lat']), longitude: parseFloat(pontoB['@_lon']) }
                );

                quilometragem += distancia;
            }
            quilometragem = quilometragem / 1000;

            const distanceChangePercentage = (quilometragem - quilometragemOriginal) / quilometragemOriginal;

            if (tempoRotaOriginal !== null) {
                tempoRota = tempoRotaOriginal * (1 + distanceChangePercentage);
            }

            if (timesOriginal.length > 1 && tempoRota !== null) {
                const startTime = Math.min(...timesOriginal.map(time => time.getTime()));
                const endTime = startTime + tempoRota * 1000;
                const timeIncrement = (endTime - startTime) / (trackPoints.length - 1);

                for (let i = 0; i < trackPoints.length; i++) {
                    const newTime = new Date(startTime + timeIncrement * i);
                    trackPoints[i].time = newTime.toISOString();
                }
            }

            const novoGpx = xmlBuilder.build(jsonObj);
            data = novoGpx;

            console.log(`Quilometragem Original: ${quilometragemOriginal.toFixed(3)} km`);
            console.log(`Quilometragem Variada: ${quilometragem.toFixed(3)} km`);
            console.log(`Variação de Quilometragem: ${(distanceChangePercentage * 100).toFixed(2)}%`);
            console.log(`Tempo Original: ${tempoRotaOriginal !== null ? tempoRotaOriginal.toFixed(0) : 'N/A'} s`);
            console.log(`Tempo Variado: ${tempoRota !== null ? tempoRota.toFixed(0) : 'N/A'} s`);

        } catch (e) {
            console.error('Erro ao modificar dados do GPX:', e);
        }

        const dataHora = new Date().toISOString();

        db.run(`
            INSERT INTO rotas_gps (rota_id, empresa, data_hora, turno, quilometragem, tempo_de_rota, arquivo_gpx) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [idRota, empresa, dataHora, turno, quilometragem, tempoRota, data], (err) => {
            if (err) {
                console.error('Erro ao inserir dados no banco de dados:', err);
            } else {
                console.log('Dados inseridos com sucesso');
            }
        });
    });
}

// Iniciar o processamento dos arquivos GPX
processGpxFiles();

// ================== CONFIGURAÇÃO DO EXPRESS ================== //

// Definir o motor de visualização como EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Servir arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal - Página inicial
app.get('/', (req, res) => {
    res.render('index');
});

// Rota para visualizar relatórios
app.get('/relatorios', (req, res) => {
    const { empresa } = req.query;
    let query = `SELECT * FROM rotas_gps`;
    const params = [];

    if (empresa) {
        query += ` WHERE empresa = ?`;
        params.push(empresa);
    }

    query += ` ORDER BY data_hora DESC`;

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Erro ao consultar o banco de dados:', err);
            res.status(500).send('Erro ao obter dados do banco.');
            return;
        }

        // Obter lista única de empresas para o filtro
        db.all(`SELECT DISTINCT empresa FROM rotas_gps`, [], (err, empresas) => {
            if (err) {
                console.error('Erro ao obter empresas:', err);
                res.status(500).send('Erro ao obter dados do banco.');
                return;
            }

            res.render('relatorios', { rotas: rows, empresas: empresas.map(e => e.empresa), selectedEmpresa: empresa || '' });
        });
    });
});


// Rota para visualizar detalhes de uma rota específica
// Rota para visualizar detalhes de uma rota específica
app.get('/relatorios/:id', (req, res) => {
    const rotaId = req.params.id;

    db.get(`SELECT * FROM rotas_gps WHERE id = ?`, [rotaId], (err, row) => {
        if (err) {
            console.error('Erro ao consultar o banco de dados:', err);
            res.status(500).send('Erro ao obter dados do banco.');
            return;
        }

        if (!row) {
            res.status(404).send('Rota não encontrada.');
            return;
        }

        res.render('detalhe', { rota: row });
    });
});

// Rota para obter o arquivo GPX de uma rota específica
app.get('/relatorios/:id/gpx', (req, res) => {
    const rotaId = req.params.id;

    db.get(`SELECT arquivo_gpx FROM rotas_gps WHERE id = ?`, [rotaId], (err, row) => {
        if (err) {
            console.error('Erro ao consultar o banco de dados:', err);
            res.status(500).send('Erro ao obter dados do banco.');
            return;
        }

        if (!row) {
            res.status(404).send('Rota não encontrada.');
            return;
        }

        res.header('Content-Type', 'application/gpx+xml');
        res.send(row.arquivo_gpx);
    });
});

// Iniciar o servidor Express
app.listen(PORT, () => {
    console.log(`Servidor web rodando em http://localhost:${PORT}`);
});
