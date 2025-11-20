import http from 'http';
import fs from 'fs';
import child_process from 'child_process';
import { WebSocketServer } from 'ws';

// Get port from environment variable or use default
const httpPort = process.env.PORT || 8997;
const wsPort = process.env.WS_PORT || 8998;

let isSyncRunning = false;
let syncProcess = undefined;
// We'll attach the WebSocket server to the same HTTP server (noServer)
let wsServer; // assigned after http server is created
function configObjectToCommandLineArr(obj) {
    let retval = [];
    let databaseObj = obj['database'];
    let tallyObj = obj['tally'];
    for (const [key, val] of Object.entries(databaseObj)) {
        retval.push('--database-' + key);
        retval.push(val);
    }
    for (const [key, val] of Object.entries(tallyObj)) {
        retval.push('--tally-' + key);
        retval.push(val);
    }
    return retval;
}
function runSyncProcess(configObj) {
    let cmdArgs = configObjectToCommandLineArr(configObj);
    syncProcess = child_process.fork('./dist/index.mjs', cmdArgs);
    syncProcess.on('message', (msg) => {
        if (wsServer) {
            wsServer.clients.forEach((wsClient) => wsClient.send(msg.toString()));
        }
    });
    syncProcess.on('close', () => {
        isSyncRunning = false;
        if (wsServer) {
            wsServer.clients.forEach((wsClient) => wsClient.send('~'));
        }
    });
}
function postTallyXML(tallyServer, tallyPort, payload) {
    return new Promise((resolve, reject) => {
        try {
            let req = http.request({
                hostname: tallyServer,
                port: tallyPort,
                path: '',
                method: 'POST',
                headers: {
                    'Content-Length': Buffer.byteLength(payload, 'utf16le'),
                    'Content-Type': 'text/xml;charset=utf-16'
                }
            }, (res) => {
                let data = '';
                res
                    .setEncoding('utf16le')
                    .on('data', (chunk) => {
                    let result = chunk.toString() || '';
                    data += result;
                })
                    .on('end', () => {
                    resolve(data);
                })
                    .on('error', (httpErr) => {
                    reject(httpErr);
                });
            });
            req.on('error', (reqError) => {
                reject(reqError);
            });
            req.write(payload, 'utf16le');
            req.end();
        }
        catch (err) {
            reject(err);
        }
    });
}
;
// Add basic CORS headers
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

const httpServer = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    // Add CORS headers to all responses
    Object.keys(corsHeaders).forEach(header => {
        res.setHeader(header, corsHeaders[header]);
    });

    let reqContent = '';
    req.on('data', (chunk) => reqContent += chunk);
    
    req.on('end', async () => {
        let contentResp = '';
        if (req.url == '/') {
            let fileContent = fs.readFileSync('./gui.html', 'utf8');
            contentResp = fileContent;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            res.end(contentResp);
            return;
        }
        else if (req.url == '/loadconfig') {
            let fileContent = fs.readFileSync('./config.json', 'utf8');
            contentResp = fileContent;
            res.setHeader('Content-Type', 'application/json');
        }
        else if (req.url == '/saveconfig') {
            fs.writeFileSync('./config.json', reqContent, { encoding: 'utf8' });
            contentResp = 'Config saved';
            res.setHeader('Content-Type', 'text/plain');
        }
        else if (req.url == '/sync') {
            let objConfig = JSON.parse(reqContent);
            if (isSyncRunning) {
                contentResp = 'Sync is already running';
            }
            else {
                isSyncRunning = true;
                runSyncProcess(objConfig);
                contentResp = 'Sync started';
            }
            res.setHeader('Content-Type', 'text/plain');
        }
        else if (req.url == '/abort') {
            if (syncProcess) {
                syncProcess.kill();
                contentResp = 'Process killed';
            }
            else {
                contentResp = 'Could not kill process';
            }
            res.setHeader('Content-Type', 'text/plain');
        }
        else if (req.url == '/list-company') {
            const reqPayload = '<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyReportLedgerTable</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyReportLedgerTable"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MyPart01"><LINES>MyLine01</LINES><REPEAT>MyLine01 : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine01"><FIELDS>Fld</FIELDS></LINE><FIELD NAME="Fld"><SET>$Name</SET><XMLTAG>ROW</XMLTAG></FIELD><COLLECTION NAME="MyCollection"><TYPE>Company</TYPE><FETCH></FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
            let objConfig = JSON.parse(reqContent);
            let result = '';
            try {
                result = await postTallyXML(objConfig['server'], objConfig['port'], reqPayload);
            }
            catch {
                result = '<DATA></DATA>';
            }
            contentResp = result;
            res.setHeader('Content-Type', 'text/xml');
        }
        else if (req.url == '/tally-status') {
            let objConfig = JSON.parse(reqContent);
            try {
                let result = await postTallyXML(objConfig['server'], objConfig['port'], '');
                contentResp = result;
            }
            catch {
                contentResp = '';
            }
            res.setHeader('Content-Type', 'text/plain');
        }
        else {
            res.writeHead(404);
            res.end();
            return;
        }
        res.statusCode = 200;
        res.end(contentResp);
    });
});
// Create WebSocket server that uses the same HTTP server (handles upgrade)
wsServer = new WebSocketServer({ noServer: true });

wsServer.on('connection', (socket) => {
    // connection established; log client info and handle close
    try {
        const remote = socket._socket && socket._socket.remoteAddress ? socket._socket.remoteAddress : 'unknown';
        console.log(`WebSocket client connected: ${remote} (total clients=${wsServer.clients.size})`);
    }
    catch (e) {
        console.log('WebSocket client connected (remote unknown)');
    }
    socket.on('message', () => { /* ignore incoming messages */ });
    socket.on('close', () => {
        console.log(`WebSocket client disconnected (total clients=${wsServer.clients.size})`);
    });
});

httpServer.on('upgrade', (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, (ws) => {
        wsServer.emit('connection', ws, request);
    });
});

httpServer.listen(httpPort, '0.0.0.0', () => {
    console.log(`HTTP Server running at http://0.0.0.0:${httpPort}`);
    console.log('WebSocket Server attached to HTTP server (same origin)');

    // Check for disconnected clients periodically
    setInterval(() => {
        if (wsServer.clients.size == 0 && !isSyncRunning) {
            console.log('No clients connected. Server still running...');
        }
    }, 30000);
});
//# sourceMappingURL=server.mjs.map