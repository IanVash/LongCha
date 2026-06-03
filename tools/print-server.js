import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

loadEnv();

const serverUrl = String(process.env.POS_SERVER_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const token = process.env.PRINT_AGENT_TOKEN || 'dev-print-agent-token';
const agentId = process.env.PRINT_AGENT_ID || `${os.hostname()}-${process.platform}`;
const pollMs = Math.max(1000, Number(process.env.PRINT_AGENT_INTERVAL_MS || 2500));
const claimLimit = Math.max(1, Math.min(10, Number(process.env.PRINT_AGENT_LIMIT || 5)));
const localHost = process.env.PRINT_SERVER_HOST || '127.0.0.1';
const localPort = Number(process.env.PRINT_SERVER_PORT || 3050);
const localToken = process.env.PRINT_SERVER_TOKEN || '';
const tempDir = path.join(os.tmpdir(), 'longcha-print-server');

const state = {
  startedAt: new Date().toISOString(),
  serverUrl,
  agentId,
  online: false,
  polling: true,
  lastPollAt: '',
  lastSuccessAt: '',
  lastError: '',
  jobsPrinted: 0,
  jobsFailed: 0,
  lastJobs: []
};

if (!token) {
  console.error('PRINT_AGENT_TOKEN es obligatorio.');
  process.exit(1);
}

function loadEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rememberJob(job, status, error = '') {
  state.lastJobs.unshift({
    id: job.id,
    role: job.role,
    orderNumber: job.orderNumber,
    status,
    error,
    at: new Date().toISOString()
  });
  state.lastJobs = state.lastJobs.slice(0, 20);
}

async function renderApi(pathname, body = {}, method = 'POST') {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Print-Agent-Token': token,
      'X-Print-Agent-Id': agentId
    },
    body: method === 'GET' ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function rawBuffer(job) {
  const rawBase64 = job.payload?.rawBase64;
  if (rawBase64) return Buffer.from(rawBase64, 'base64');
  return Buffer.from(job.payload?.plainText || '', 'utf8');
}

function plainText(job) {
  return String(job.payload?.plainText || Buffer.from(rawBuffer(job)).toString('utf8'));
}

const WINDOWS_THERMAL_PRINT_SCRIPT = `
param(
  [string]$TextPath,
  [string]$PrinterName,
  [int]$PaperWidthMm = 80,
  [double]$FontSizePt = 13,
  [string]$DocumentName = "Long Cha Ticket"
)

Add-Type -AssemblyName System.Drawing

$text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
$lines = @($text -split "\\r?\\n")
$script:lineIndex = 0
$paperWidth = [Math]::Max(210, [Math]::Round(($PaperWidthMm / 25.4) * 100))
$estimatedHeight = [Math]::Max(600, [Math]::Min(3200, [Math]::Round((($lines.Count + 8) * ($FontSizePt / 72) * 100) * 1.28)))

$document = New-Object System.Drawing.Printing.PrintDocument
$document.DocumentName = $DocumentName
$document.PrinterSettings.PrinterName = $PrinterName
$document.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize("LongChaTicket", $paperWidth, $estimatedHeight)
$document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(4, 4, 4, 4)

$font = New-Object System.Drawing.Font("Consolas", $FontSizePt, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$brush = [System.Drawing.Brushes]::Black

$document.add_PrintPage({
  param($sender, $eventArgs)
  $eventArgs.Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
  $left = $eventArgs.MarginBounds.Left
  $top = $eventArgs.MarginBounds.Top
  $bottom = $eventArgs.MarginBounds.Bottom
  $lineHeight = [Math]::Ceiling($font.GetHeight($eventArgs.Graphics) * 1.04)
  $y = $top

  while ($script:lineIndex -lt $lines.Count) {
    if (($y + $lineHeight) -gt $bottom) {
      $eventArgs.HasMorePages = $true
      return
    }
    $eventArgs.Graphics.DrawString($lines[$script:lineIndex], $font, $brush, $left, $y)
    $y += $lineHeight
    $script:lineIndex += 1
  }

  $eventArgs.HasMorePages = $false
})

$document.Print()
$font.Dispose()
$document.Dispose()
`;

function printToNetwork(job) {
  const printer = job.printerConfig || {};
  const host = printer.networkHost;
  const port = Number(printer.networkPort || 9100);
  if (!host) throw new Error(`El trabajo ${job.id} no tiene IP/host de impresora.`);
  const buffer = rawBuffer(job);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 10000 }, () => {
      socket.write(buffer);
      socket.end();
    });
    socket.on('close', resolve);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Timeout conectando a ${host}:${port}`));
    });
    socket.on('error', reject);
  });
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

async function printToWindowsPrinter(job) {
  const printerName = job.printerConfig?.systemPrinterName || job.printerConfig?.name;
  if (!printerName) throw new Error(`El trabajo ${job.id} no tiene impresora instalada configurada.`);
  await mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `job-${job.id}-${Date.now()}.txt`);
  const scriptPath = path.join(tempDir, `print-${job.id}-${Date.now()}.ps1`);
  await writeFile(filePath, plainText(job), 'utf8');
  await writeFile(scriptPath, WINDOWS_THERMAL_PRINT_SCRIPT, 'utf8');
  const paperWidth = String(job.printerConfig?.ticketWidthMm || 80);
  const fontSize = String(job.printerConfig?.fontSizePt || (Number(paperWidth) === 58 ? 12 : 13));
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-TextPath',
      filePath,
      '-PrinterName',
      printerName,
      '-PaperWidthMm',
      paperWidth,
      '-FontSizePt',
      fontSize,
      '-DocumentName',
      job.payload?.title || `Long Cha ${job.orderNumber || job.id}`
    ], {
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 128 * 1024
    });
  } finally {
    await rm(filePath, { force: true }).catch(() => {});
    await rm(scriptPath, { force: true }).catch(() => {});
  }
}

async function printToSystemPrinter(job) {
  if (process.platform === 'win32') return printToWindowsPrinter(job);
  const printerName = job.printerConfig?.systemPrinterName || job.printerConfig?.name;
  if (!printerName) throw new Error(`El trabajo ${job.id} no tiene impresora instalada configurada.`);
  await mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `job-${job.id}-${Date.now()}.txt`);
  await writeFile(filePath, plainText(job), 'utf8');
  try {
    await execFileAsync('lp', ['-d', printerName, filePath], {
      timeout: 20000,
      maxBuffer: 128 * 1024
    });
  } finally {
    await rm(filePath, { force: true }).catch(() => {});
  }
}

async function printJob(job) {
  const mode = job.printerConfig?.connectionMode || 'browser';
  if (mode === 'network') return printToNetwork(job);
  if (mode === 'system') return printToSystemPrinter(job);
  throw new Error(`El trabajo ${job.id} usa modo navegador y no corresponde al servidor local.`);
}

async function handleJob(job) {
  try {
    await printJob(job);
    await renderApi(`/api/print-agent/jobs/${job.id}/complete`, { agentId });
    state.jobsPrinted += 1;
    state.lastSuccessAt = new Date().toISOString();
    rememberJob(job, 'printed');
    console.log(`[ok] ${job.id} ${job.role} ${job.orderNumber}`);
  } catch (error) {
    state.jobsFailed += 1;
    rememberJob(job, 'failed', error.message);
    await renderApi(`/api/print-agent/jobs/${job.id}/fail`, { agentId, error: error.message }).catch((failError) => {
      console.error(`[fail-report] ${job.id}: ${failError.message}`);
    });
    console.error(`[error] ${job.id} ${job.role} ${job.orderNumber}: ${error.message}`);
  }
}

async function claimOnce() {
  state.lastPollAt = new Date().toISOString();
  const { jobs = [] } = await renderApi('/api/print-agent/jobs/claim', { agentId, limit: claimLimit });
  state.online = true;
  state.lastError = '';
  for (const job of jobs) await handleJob(job);
  return jobs;
}

async function pollLoop() {
  console.log(`Long Cha print server conectado a ${serverUrl}`);
  console.log(`Agente: ${agentId}`);
  console.log(`Panel local: http://${localHost}:${localPort}`);
  while (state.polling) {
    try {
      await claimOnce();
    } catch (error) {
      state.online = false;
      state.lastError = error.message;
      console.error(`[poll] ${error.message}`);
    }
    await sleep(pollMs);
  }
}

function normalizeDetectedPrinter(printer, platform, defaultPrinter = '') {
  const name = String(printer.Name || printer.name || '').trim();
  if (!name) return null;
  const port = String(printer.PortName || printer.port || printer.DeviceUri || '').trim();
  const isNetwork = Boolean(printer.Network) || /network/i.test(name) || /^IP_|^TCP|^WSD|^\d{1,3}(\.\d{1,3}){3}|socket:|ipp:|lpd:/i.test(port);
  return {
    id: name,
    name,
    driver: String(printer.DriverName || printer.driver || '').trim(),
    port,
    source: platform,
    connection: isNetwork ? 'red' : 'pc',
    isDefault: Boolean(printer.Default) || name === defaultPrinter,
    isShared: Boolean(printer.Shared)
  };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function detectWindowsPrinters() {
  const script = `
    $printers = @()
    $defaultPrinter = ''
    try {
      $printers = Get-Printer | Select-Object Name,DriverName,PortName,Shared,PrinterStatus
    } catch {
      try {
        $printers = Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PortName,Network,Local,Shared,Default
      } catch {
        $printers = @()
      }
    }
    try {
      $defaultPrinter = (Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1 -ExpandProperty Name)
    } catch {
      $defaultPrinter = ''
    }
    [PSCustomObject]@{
      platform = 'windows'
      source = 'windows-print-spooler'
      defaultPrinter = $defaultPrinter
      printers = @($printers)
    } | ConvertTo-Json -Compress -Depth 5
  `;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 512 * 1024
  });
  const payload = JSON.parse(stdout || '{}');
  const printers = asArray(payload.printers)
    .map((printer) => normalizeDetectedPrinter(printer, 'windows', payload.defaultPrinter || ''))
    .filter(Boolean)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  return {
    platform: 'windows',
    source: payload.source || 'windows-print-spooler',
    printers,
    message: printers.length ? '' : 'No se encontraron impresoras instaladas en esta PC.'
  };
}

async function detectCupsPrinters() {
  const { stdout } = await execFileAsync('lpstat', ['-v'], {
    timeout: 5000,
    maxBuffer: 256 * 1024
  });
  const printers = stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^device for\s+(.+?):\s+(.+)$/i);
      if (!match) return null;
      return normalizeDetectedPrinter({ Name: match[1], DeviceUri: match[2], PortName: match[2] }, process.platform);
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    platform: process.platform,
    source: 'cups',
    printers,
    message: printers.length ? '' : 'No se encontraron impresoras configuradas en CUPS.'
  };
}

async function detectConnectedPrinters() {
  try {
    if (process.platform === 'win32') return await detectWindowsPrinters();
    if (process.platform === 'darwin' || process.platform === 'linux') return await detectCupsPrinters();
    return {
      platform: process.platform,
      source: 'unsupported',
      printers: [],
      message: 'Este sistema operativo no tiene deteccion automatica de impresoras configurada.'
    };
  } catch (error) {
    return {
      platform: process.platform,
      source: process.platform === 'win32' ? 'windows-print-spooler' : 'cups',
      printers: [],
      message: `No se pudieron detectar impresoras en esta PC: ${error.message}`
    };
  }
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function localDashboard() {
  const status = state.online ? 'Conectado' : 'Sin conexion';
  const jobs = state.lastJobs.length
    ? state.lastJobs.map((job) => `
      <tr>
        <td>${htmlEscape(job.at)}</td>
        <td>${htmlEscape(job.orderNumber)}</td>
        <td>${htmlEscape(job.role)}</td>
        <td>${htmlEscape(job.status)}</td>
        <td>${htmlEscape(job.error)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5">Sin trabajos recientes.</td></tr>';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Long Cha Print Server</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #fff8e8; color: #171717; }
    main { width: min(1040px, calc(100% - 28px)); margin: 0 auto; padding: 24px 0; display: grid; gap: 16px; }
    section { background: #fffdfa; border: 1px solid #e7dcc8; border-radius: 8px; padding: 16px; }
    h1, h2 { margin: 0 0 8px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .box { background: #fffaf0; border: 1px solid #e7dcc8; border-radius: 8px; padding: 12px; }
    .ok { color: #146e43; font-weight: 800; }
    .bad { color: #a33422; font-weight: 800; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #eee1c8; padding: 8px; font-size: 14px; }
    code { background: #fff2cf; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Long Cha Print Server</h1>
      <p>Estado: <span class="${state.online ? 'ok' : 'bad'}">${status}</span></p>
      <p>Servidor Render/POS: <code>${htmlEscape(serverUrl)}</code></p>
      <p>Agente: <code>${htmlEscape(agentId)}</code></p>
    </section>
    <section class="grid">
      <div class="box"><strong>Impresos</strong><br>${state.jobsPrinted}</div>
      <div class="box"><strong>Fallidos</strong><br>${state.jobsFailed}</div>
      <div class="box"><strong>Ultimo poll</strong><br>${htmlEscape(state.lastPollAt || 'Pendiente')}</div>
      <div class="box"><strong>Ultimo error</strong><br>${htmlEscape(state.lastError || 'Sin errores')}</div>
    </section>
    <section>
      <h2>Trabajos recientes</h2>
      <table>
        <thead><tr><th>Hora</th><th>Orden</th><th>Rol</th><th>Estado</th><th>Error</th></tr></thead>
        <tbody>${jobs}</tbody>
      </table>
    </section>
    <section>
      <h2>Endpoints locales</h2>
      <p><code>GET /health</code> estado del servidor local</p>
      <p><code>GET /printers</code> impresoras detectadas en esta PC</p>
      <p><code>POST /poll/run</code> buscar trabajos pendientes ahora</p>
      <p><code>POST /test</code> imprimir una prueba enviando printerConfig y text</p>
    </section>
  </main>
</body>
</html>`;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Print-Server-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Print-Server-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorizeLocal(req, res) {
  if (!localToken) return true;
  const provided = String(req.headers['x-print-server-token'] || '');
  if (provided === localToken) return true;
  sendJson(res, 401, { error: 'Token local invalido.' });
  return false;
}

async function handleLocalRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${localHost}:${localPort}`}`);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, 200, localDashboard());
  if (!authorizeLocal(req, res)) return null;

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      ...state,
      uptimeSeconds: Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000)
    });
  }
  if (req.method === 'GET' && url.pathname === '/printers') {
    return sendJson(res, 200, await detectConnectedPrinters());
  }
  if (req.method === 'POST' && url.pathname === '/poll/run') {
    const jobs = await claimOnce();
    return sendJson(res, 200, { ok: true, jobsClaimed: jobs.length, jobs });
  }
  if (req.method === 'POST' && url.pathname === '/test') {
    const body = await readJson(req);
    const job = {
      id: `test-${Date.now()}`,
      role: 'test',
      orderNumber: 'PRUEBA',
      printerConfig: body.printerConfig || {},
      payload: {
        plainText: body.text || 'Long Cha\nPrueba de impresion\n\n',
        rawBase64: body.rawBase64 || ''
      }
    };
    await printJob(job);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Ruta no encontrada.' });
}

const localServer = http.createServer((req, res) => {
  handleLocalRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: error.message });
  });
});

localServer.listen(localPort, localHost, () => {
  console.log(`Servidor local listo en http://${localHost}:${localPort}`);
});

pollLoop().catch((error) => {
  console.error(error);
  process.exit(1);
});
