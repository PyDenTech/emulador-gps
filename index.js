require('dotenv').config();

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
            descricao TEXT,
            arquivo_gpx TEXT
        )
    `, (err) => {
        if (err) {
            console.error('Erro ao criar a tabela:', err);
        }
    });

    // Adicionar a coluna 'descricao' se não existir
    db.all(`PRAGMA table_info(rotas_gps);`, (err, columns) => {
        if (err) {
            console.error('Erro ao verificar colunas da tabela:', err);
        } else {
            const columnNames = columns.map(col => col.name);
            if (!columnNames.includes('descricao')) {
                db.run(`ALTER TABLE rotas_gps ADD COLUMN descricao TEXT`, (err) => {
                    if (err) {
                        console.error('Erro ao adicionar a coluna descricao:', err);
                    } else {
                        console.log('Coluna descricao adicionada com sucesso.');
                    }
                });
            }
        }
    });
});

// Função para processar arquivos GPX e agendar tarefas
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

                // Mapear o turno para o horário correspondente (todos os dias)
                const horarios = {
                    'manha': '0 7 * * *',        // 07:00 AM todos os dias
                    'meio': '0 13 * * *',        // 01:00 PM todos os dias
                    'tarde': '45 18 * * *',      // 06:45 PM todos os dias
                    'noite': '0 19 * * *',       // 07:00 PM todos os dias
                    'madrugada': '45 23 * * *'   // 11:45 PM todos os dias
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

// Agendar uma tarefa com node-cron
function scheduleTask(cronExpression, filePath, { idRota, empresa, turno }) {
    cron.schedule(cronExpression, () => {
        // Tarefa executada nos horários agendados
        console.log(`Enviando dados do arquivo ${filePath} no turno ${turno}`);
        sendDataToDatabase(filePath, { idRota, empresa, turno });
    }, {
        timezone: "America/Sao_Paulo" // Defina o fuso horário conforme necessário
    });
}

// Função para enviar dados para o banco de dados
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

        // Extrair a descrição do lugar correto
        let descricao = '';
        if (jsonObj.gpx.metadata && jsonObj.gpx.metadata.desc) {
            descricao = jsonObj.gpx.metadata.desc;
        } else if (track.desc) {
            descricao = track.desc;
        }

        let quilometragem = 0;
        let tempoRota = 0;

        try {
            const trackSegments = Array.isArray(track.trkseg) ? track.trkseg : [track.trkseg];
            const trackPoints = trackSegments.flatMap(seg => Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt]);

            // Calcular distâncias e quilometragem
            let totalDistance = 0;
            const distances = [];

            for (let i = 0; i < trackPoints.length - 1; i++) {
                const pontoA = trackPoints[i];
                const pontoB = trackPoints[i + 1];

                const distance = geolib.getDistance(
                    { latitude: parseFloat(pontoA['@_lat']), longitude: parseFloat(pontoA['@_lon']) },
                    { latitude: parseFloat(pontoB['@_lat']), longitude: parseFloat(pontoB['@_lon']) }
                );

                distances.push(distance);
                totalDistance += distance;
            }

            quilometragem = totalDistance / 1000; // Converter para km

            // Cálculo do tempo de rota com base na velocidade média de 40 km/h
            const averageSpeed = 40; // km/h
            const totalTimeHours = quilometragem / averageSpeed; // Tempo em horas
            const totalTimeMinutes = totalTimeHours * 60; // Converter para minutos
            const totalTimeSeconds = totalTimeHours * 3600; // Converter para segundos
            tempoRota = totalTimeMinutes;

            // Atribuir timestamps aos pontos
            const startTime = new Date();
            let accumulatedTime = 0;

            for (let i = 0; i < trackPoints.length; i++) {
                if (i === 0) {
                    trackPoints[i].time = startTime.toISOString();
                } else {
                    const timeIntervalSeconds = (distances[i - 1] / totalDistance) * totalTimeSeconds;
                    accumulatedTime += timeIntervalSeconds * 1000; // Converter para milissegundos
                    const pointTime = new Date(startTime.getTime() + accumulatedTime);
                    trackPoints[i].time = pointTime.toISOString();
                }
            }

            // Atualizar o arquivo GPX com os novos timestamps
            const novoGpx = xmlBuilder.build(jsonObj);
            data = novoGpx;

            console.log(`Quilometragem: ${quilometragem.toFixed(3)} km`);
            console.log(`Tempo de Rota: ${tempoRota.toFixed(2)} minutos`);
            console.log(`Descrição: ${descricao}`);

        } catch (e) {
            console.error('Erro ao modificar dados do GPX:', e);
        }

        const dataHora = new Date().toISOString();

        db.run(`
            INSERT INTO rotas_gps (rota_id, empresa, data_hora, turno, quilometragem, tempo_de_rota, descricao, arquivo_gpx) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [idRota, empresa, dataHora, turno, quilometragem, tempoRota, descricao, data], (err) => {
            if (err) {
                console.error('Erro ao inserir dados no banco de dados:', err);
            } else {
                console.log('Dados inseridos com sucesso');
            }
        });
    });
}

// Iniciar o processamento dos arquivos GPX e agendar tarefas
processGpxFiles();

// ================== CONFIGURAÇÃO DO EXPRESS ================== //

// Definir o motor de visualização como EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Servir arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Middleware para parsear o corpo das requisições
app.use(express.urlencoded({ extended: true }));

// Rota principal - Página inicial
app.get('/', (req, res) => {
    res.render('index');
});

// Função para construir a cláusula WHERE e os parâmetros
function buildWhereClauseAndParams(filters) {
    let whereClause = '';
    const params = [];

    if (filters.empresa) {
        whereClause += ` AND empresa = ?`;
        params.push(filters.empresa);
    }

    if (filters.rotaId) {
        whereClause += ` AND rota_id LIKE ?`;
        params.push(`%${filters.rotaId}%`);
    }

    if (filters.descricao) {
        whereClause += ` AND descricao LIKE ?`;
        params.push(`%${filters.descricao}%`);
    }

    if (filters.turno) {
        whereClause += ` AND turno = ?`;
        params.push(filters.turno);
    }

    if (filters.dataInicio) {
        whereClause += ` AND date(substr(data_hora, 1, 10)) >= date(?)`;
        params.push(filters.dataInicio);
    }

    if (filters.dataFim) {
        whereClause += ` AND date(substr(data_hora, 1, 10)) <= date(?)`;
        params.push(filters.dataFim);
    }

    return { whereClause, params };
}

// Rota para visualizar relatórios
app.get('/relatorios', (req, res) => {
    const tab = req.query.tab || 'detalhados'; // Aba ativa (detalhados ou agregados)
    const { empresa, rotaId, descricao, turno, dataInicio, dataFim } = req.query;

    const empresasPromise = new Promise((resolve, reject) => {
        db.all(`SELECT DISTINCT empresa FROM rotas_gps`, [], (err, empresas) => {
            if (err) {
                reject(err);
            } else {
                resolve(empresas.map(e => e.empresa));
            }
        });
    });

    if (tab === 'detalhados') {
        // Parâmetros de paginação
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const offset = (page - 1) * limit;

        // Construir a cláusula WHERE e os parâmetros
        const { whereClause, params } = buildWhereClauseAndParams({ empresa, rotaId, descricao, turno, dataInicio, dataFim });

        // Consulta de contagem
        const countQuery = `SELECT COUNT(*) as total FROM rotas_gps WHERE 1=1 ${whereClause}`;
        db.get(countQuery, params, (err, countResult) => {
            if (err) {
                console.error('Erro ao contar registros:', err);
                res.status(500).send('Erro ao obter dados do banco.');
                return;
            }

            const totalRecords = countResult.total;
            const totalPages = Math.ceil(totalRecords / limit);

            // Consulta de dados com paginação
            const detailedQuery = `SELECT * FROM rotas_gps WHERE 1=1 ${whereClause} ORDER BY data_hora DESC LIMIT ? OFFSET ?`;
            const detailedParams = [...params, limit, offset];

            db.all(detailedQuery, detailedParams, (err, rows) => {
                if (err) {
                    console.error('Erro ao consultar o banco de dados:', err);
                    res.status(500).send('Erro ao obter dados do banco.');
                    return;
                }

                empresasPromise.then(empresas => {
                    // Construir a query string para paginação
                    const queryObj = { ...req.query };
                    delete queryObj.page;
                    const paginationQuery = new URLSearchParams(queryObj).toString();

                    res.render('relatorios', {
                        tab: 'detalhados',
                        rotas: rows,
                        aggregate: null,
                        empresas: empresas,
                        selectedEmpresa: empresa || '',
                        rotaId: rotaId || '',
                        descricao: descricao || '',
                        turno: turno || '',
                        currentPage: page,
                        totalPages,
                        paginationQuery,
                        dataInicio: dataInicio || '',
                        dataFim: dataFim || ''
                    });
                }).catch(err => {
                    console.error('Erro ao obter empresas:', err);
                    res.status(500).send('Erro ao obter dados do banco.');
                });
            });
        });
    } else if (tab === 'agregados') {
        // Construir a cláusula WHERE e os parâmetros
        const { whereClause, params } = buildWhereClauseAndParams({ empresa, dataInicio, dataFim });

        let aggregateQuery = `
            SELECT 
                rota_id,
                MAX(descricao) as descricao,
                date(substr(data_hora, 1, 10)) as data,
                SUM(quilometragem) as total_quilometragem,
                AVG(tempo_de_rota) as avg_tempo_rota
            FROM rotas_gps
            WHERE 1=1 ${whereClause}
            GROUP BY rota_id, data
            ORDER BY data DESC, rota_id
        `;

        db.all(aggregateQuery, params, (err, aggregateRows) => {
            if (err) {
                console.error('Erro ao consultar dados agregados:', err);
                res.status(500).send('Erro ao obter dados agregados do banco.');
                return;
            }

            empresasPromise.then(empresas => {
                res.render('relatorios', {
                    tab: 'agregados',
                    rotas: [],
                    aggregate: aggregateRows,
                    empresas: empresas,
                    selectedEmpresa: empresa || '',
                    dataInicio: dataInicio || '',
                    dataFim: dataFim || '',
                    rotaId: '',
                    descricao: '',
                    turno: '',
                    currentPage: 1,
                    totalPages: 1,
                    paginationQuery: ''
                });
            }).catch(err => {
                console.error('Erro ao obter empresas:', err);
                res.status(500).send('Erro ao obter dados do banco.');
            });
        });
    } else {
        res.redirect('/relatorios?tab=detalhados');
    }
});

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
