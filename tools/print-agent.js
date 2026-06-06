import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const serverUrl = String(process.env.POS_SERVER_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const token = process.env.PRINT_AGENT_TOKEN || 'dev-print-agent-token';
const agentId = process.env.PRINT_AGENT_ID || `${os.hostname()}-${process.platform}`;
const pollMs = Math.max(1000, Number(process.env.PRINT_AGENT_INTERVAL_MS || 2500));
const claimLimit = Math.max(1, Math.min(10, Number(process.env.PRINT_AGENT_LIMIT || 5)));
const tempDir = path.join(os.tmpdir(), 'longcha-print-agent');

if (!token) {
  console.error('PRINT_AGENT_TOKEN es obligatorio.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathname, body = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Print-Agent-Token': token,
      'X-Print-Agent-Id': agentId
    },
    body: JSON.stringify(body)
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
  [double]$FontSizePt = 10.5,
  [string]$DocumentName = "Long Cha Ticket"
)

Add-Type -AssemblyName System.Drawing

$text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
$lines = @($text -split "\\r?\\n")
$script:lineIndex = 0
$effectiveFontSize = [Math]::Max(8.5, [Math]::Min(10.5, $FontSizePt))
$paperWidth = [Math]::Max(210, [Math]::Round(($PaperWidthMm / 25.4) * 100))
$estimatedHeight = [Math]::Max(260, [Math]::Min(1800, [Math]::Round((($lines.Count + 4) * (($effectiveFontSize + 2) / 72) * 100) + 28)))

$document = New-Object System.Drawing.Printing.PrintDocument
$document.DocumentName = $DocumentName
$document.PrinterSettings.PrinterName = $PrinterName
$document.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize("LongChaTicket", $paperWidth, $estimatedHeight)
$document.DefaultPageSettings.Landscape = $false
$document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(2, 2, 2, 2)
$document.OriginAtMargins = $true

$font = New-Object System.Drawing.Font("Consolas", $effectiveFontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$brush = [System.Drawing.Brushes]::Black

$document.add_PrintPage({
  param($sender, $eventArgs)
  $eventArgs.Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
  $left = $eventArgs.MarginBounds.Left
  $top = $eventArgs.MarginBounds.Top
  $bottom = $eventArgs.MarginBounds.Bottom
  $lineHeight = [Math]::Ceiling($font.GetHeight($eventArgs.Graphics) * 0.98)
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
  const configuredFontSize = Number(job.printerConfig?.fontSizePt || (Number(paperWidth) === 58 ? 10.5 : 10.5));
  const fontSize = String(Math.max(8.5, Math.min(10.5, configuredFontSize)));
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
  throw new Error(`El trabajo ${job.id} usa modo navegador y no corresponde al agente local.`);
}

async function handleJob(job) {
  try {
    await printJob(job);
    await api(`/api/print-agent/jobs/${job.id}/complete`, { agentId });
    console.log(`[ok] ${job.id} ${job.role} ${job.orderNumber}`);
  } catch (error) {
    await api(`/api/print-agent/jobs/${job.id}/fail`, { agentId, error: error.message }).catch((failError) => {
      console.error(`[fail-report] ${job.id}: ${failError.message}`);
    });
    console.error(`[error] ${job.id} ${job.role} ${job.orderNumber}: ${error.message}`);
  }
}

async function loop() {
  console.log(`Long Cha print agent conectado a ${serverUrl}`);
  console.log(`Agente: ${agentId}`);
  while (true) {
    try {
      const { jobs = [] } = await api('/api/print-agent/jobs/claim', { agentId, limit: claimLimit });
      for (const job of jobs) await handleJob(job);
    } catch (error) {
      console.error(`[poll] ${error.message}`);
    }
    await sleep(pollMs);
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});
