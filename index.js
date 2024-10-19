require('dotenv').config(); // Importar e configurar o dotenv

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Client } = require('pg');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const geolib = require('geolib');

const gpxDirectory = path.join(__dirname, 'arquivos-gpx');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

client.connect()
    .then(() => console.log('Conectado ao banco de dados PostgreSQL'))
    .catch(err => console.error('Erro ao conectar no banco de dados:', err));

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
                    'tarde': '30 18 * * 1-5',
                    'noite': '0 19 * * 1-5',
                    'madrugada': '25 19 * * 1-5'
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

        // Criar instâncias do XMLParser e XMLBuilder
        const xmlParser = new XMLParser({ ignoreAttributes: false });
        const xmlBuilder = new XMLBuilder({ ignoreAttributes: false });

        // Parsear o arquivo GPX
        const jsonObj = xmlParser.parse(data);

        // Verificar a estrutura do GPX
        const track = jsonObj?.gpx?.trk;
        if (!track) {
            console.error('Track não encontrado no arquivo GPX.');
            return;
        }

        // Inicializar variáveis
        let quilometragemOriginal = 0;
        let tempoRotaOriginal = null;
        let quilometragem = 0;
        let tempoRota = null;

        try {
            const trackSegments = Array.isArray(track.trkseg) ? track.trkseg : [track.trkseg];
            const trackPoints = trackSegments.flatMap(seg => Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt]);

            // **Calcular a quilometragem e tempo de rota originais**
            for (let i = 0; i < trackPoints.length - 1; i++) {
                const pontoA = trackPoints[i];
                const pontoB = trackPoints[i + 1];

                const distancia = geolib.getDistance(
                    { latitude: parseFloat(pontoA['@_lat']), longitude: parseFloat(pontoA['@_lon']) },
                    { latitude: parseFloat(pontoB['@_lat']), longitude: parseFloat(pontoB['@_lon']) }
                );

                quilometragemOriginal += distancia;
            }
            quilometragemOriginal = quilometragemOriginal / 1000; // Converter para quilômetros

            // Tempo de rota original
            const timesOriginal = trackPoints
                .map(point => new Date(point.time))
                .filter(time => !isNaN(time));

            if (timesOriginal.length > 1) {
                const timeStampsOriginal = timesOriginal.map(time => time.getTime());
                tempoRotaOriginal = (Math.max(...timeStampsOriginal) - Math.min(...timeStampsOriginal)) / 1000; // em segundos
            } else {
                tempoRotaOriginal = null;
            }

            // **Adicionar variação às coordenadas dos pontos**
            const coordenadaVariacao = 0.00002; // Aproximadamente 2.2 metros
            for (let i = 0; i < trackPoints.length; i++) {
                const point = trackPoints[i];

                // Variar latitude e longitude
                const latVariacao = (Math.random() * (2 * coordenadaVariacao)) - coordenadaVariacao;
                const lonVariacao = (Math.random() * (2 * coordenadaVariacao)) - coordenadaVariacao;

                point['@_lat'] = (parseFloat(point['@_lat']) + latVariacao).toFixed(6);
                point['@_lon'] = (parseFloat(point['@_lon']) + lonVariacao).toFixed(6);
            }

            // **Recalcular a quilometragem com os novos pontos**
            for (let i = 0; i < trackPoints.length - 1; i++) {
                const pontoA = trackPoints[i];
                const pontoB = trackPoints[i + 1];

                const distancia = geolib.getDistance(
                    { latitude: parseFloat(pontoA['@_lat']), longitude: parseFloat(pontoA['@_lon']) },
                    { latitude: parseFloat(pontoB['@_lat']), longitude: parseFloat(pontoB['@_lon']) }
                );

                quilometragem += distancia;
            }
            quilometragem = quilometragem / 1000; // Converter para quilômetros

            // **Calcular a porcentagem de mudança na quilometragem**
            const distanceChangePercentage = (quilometragem - quilometragemOriginal) / quilometragemOriginal;

            // **Ajustar o tempo de rota proporcionalmente**
            if (tempoRotaOriginal !== null) {
                tempoRota = tempoRotaOriginal * (1 + distanceChangePercentage);
            }

            // **Atualizar os timestamps dos pontos**
            if (timesOriginal.length > 1 && tempoRota !== null) {
                const startTime = Math.min(...timesOriginal.map(time => time.getTime()));
                const endTime = startTime + tempoRota * 1000; // novo tempo final em milissegundos
                const timeIncrement = (endTime - startTime) / (trackPoints.length - 1);

                for (let i = 0; i < trackPoints.length; i++) {
                    const newTime = new Date(startTime + timeIncrement * i);
                    trackPoints[i].time = newTime.toISOString();
                }
            }

            // Reconstituir o GPX com os novos dados
            const novoGpx = xmlBuilder.build(jsonObj);
            data = novoGpx; // Atualizar o conteúdo do GPX a ser armazenado

            // **Logs para verificação**
            console.log(`Quilometragem Original: ${quilometragemOriginal.toFixed(3)} km`);
            console.log(`Quilometragem Variada: ${quilometragem.toFixed(3)} km`);
            console.log(`Variação de Quilometragem: ${(distanceChangePercentage * 100).toFixed(2)}%`);
            console.log(`Tempo Original: ${tempoRotaOriginal !== null ? tempoRotaOriginal.toFixed(0) : 'N/A'} s`);
            console.log(`Tempo Variado: ${tempoRota !== null ? tempoRota.toFixed(0) : 'N/A'} s`);

        } catch (e) {
            console.error('Erro ao modificar dados do GPX:', e);
        }

        // Preparar a data e hora atual
        const dataHora = new Date();

        // Inserir no banco de dados
        const query = `
            INSERT INTO rotas_gps (rota_id, empresa, data_hora, turno, quilometragem, tempo_de_rota, arquivo_gpx) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        const values = [idRota, empresa, dataHora, turno, quilometragem, tempoRota, data];

        client.query(query, values)
            .then(res => {
                console.log('Dados inseridos com sucesso:', res.rowCount);
            })
            .catch(err => {
                console.error('Erro ao inserir dados no banco de dados:', err);
            });
    });
}

processGpxFiles();
