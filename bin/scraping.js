// bin/scraping.js — Modo B melhorado (perfil persistente + spoofing anti-detect)
import puppeteer from 'puppeteer-extra';
import { executablePath as chromiumExecutablePath } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker'; // <-- COMENTEI (pode denunciar)
import UserPreferencesPlugin from 'puppeteer-extra-plugin-user-preferences';
import fs from 'fs';
import readline from 'readline';
import path from 'path';

import { readBarcodePDF } from './readBarcodePDF.js';
import { logger } from './loggers.js';

const downloadPath = process.cwd() + '/bin';
const COOKIES_FILE = './.cookies.json';
const CHROME_PROFILE = path.resolve('./chrome-profile');

// util helpers (mesmos da versão anterior)
async function waitForHumanOrNavigation(page, { selector, timeoutAuto = 60000 } = {}) {
  if (selector) {
    try {
      console.log(`Aguardando seletor "${selector}" (até ${timeoutAuto}ms)…`);
      await page.waitForSelector(selector, { timeout: timeoutAuto });
      console.log('Seletor detectado — seguindo automaticamente.');
      return { method: 'selector' };
    } catch {}
  }

  try {
    await page.waitForNavigation({ timeout: timeoutAuto, waitUntil: 'networkidle0' });
    console.log('Navegação detectada — seguindo automaticamente.');
    return { method: 'navigation' };
  } catch {
    console.log('>>> Resolva o captcha na janela do navegador.');
    console.log('>>> Quando terminar, volte ao terminal e pressione ENTER para continuar.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question('', () => { rl.close(); resolve(); }));
    console.log('ENTER recebido — retomando execução.');
    return { method: 'manual' };
  }
}

async function saveCookiesToFile(page, pathFile = COOKIES_FILE) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(pathFile, JSON.stringify(cookies, null, 2));
    console.log(`Cookies salvos em ${pathFile}`);
  } catch (err) {
    console.log('Erro ao salvar cookies:', err.message || err);
  }
}

async function loadCookiesFromFile(page, pathFile = COOKIES_FILE) {
  if (!fs.existsSync(pathFile)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(pathFile));
    if (Array.isArray(cookies) && cookies.length) {
      await page.setCookie(...cookies);
      console.log(`Cookies carregados de ${pathFile}`);
      return true;
    }
  } catch (err) {
    console.log('Falha ao carregar cookies:', err.message || err);
  }
  return false;
}

// plugins
puppeteer.use(StealthPlugin());
// puppeteer.use(AdblockerPlugin({ blockTrackers: true })); // COMENTADO: pode aumentar chance de bloqueio
puppeteer.use(
  UserPreferencesPlugin({
    userPrefs: {
      download: {
        prompt_for_download: false,
        open_pdf_in_system_reader: true,
        default_directory: downloadPath,
      },
      plugins: { always_open_pdf_externally: true },
    },
  })
);

// função principal
async function scraping(answers) {
  const { cnpj, month, year, headless } = answers;

  // allow override via env (point to real Chrome)
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || chromiumExecutablePath();

  const browser = await puppeteer.launch({
    headless: headless, // false preferível
    userDataDir: CHROME_PROFILE,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=pt-BR',
      '--disable-infobars',
      '--window-size=1366,768',
    ],
    defaultViewport: null,
    executablePath: execPath,
  });

  const pages = await browser.pages();
  const page = pages.length ? pages[0] : await browser.newPage();

  // --- Evitar sinais óbvios: injetar script ANTES de qualquer navegação
  await page.evaluateOnNewDocument(() => {
    // navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // languages
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR','pt','en-US','en'] });

    // plugins (falso)
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });

    // permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.__proto__.query = (params) => (
      params.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : originalQuery(params)
    );

    // window.chrome
    window.chrome = { runtime: {} };

    // WebGL vendor/render info (mudar se detectável)
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter(parameter);
    };

    // small console tamper (não essencial)
    const originalConsoleWarn = console.warn;
    console.warn = function () {
      originalConsoleWarn.apply(console, arguments);
    };
  });

  // ajustes de headers e UA
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8' });
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(120000);

  // headless downloads / PDF
  if (headless) {
    page.on('response', (resp) => {
      const header = resp.headers();
      readBarcodePDF(header);
    });
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath });
  }

  // Stage 1 - abrir
  await loadCookiesFromFile(page, COOKIES_FILE);
  await page.goto('http://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao', { waitUntil: 'networkidle2' });

  // Stage 2 - entrada manual (continua sendo mais seguro)
  await page.waitForSelector('input#cnpj', { visible: true });

  console.log('==============================================================');
  console.log('Digite o CNPJ manualmente na página e clique em "Continuar".');
  console.log('Resolva o hCaptcha se aparecer. O script aguardará a próxima tela.');
  console.log('Se não progredir, pressione ENTER no terminal para forçar continuar.');
  console.log('==============================================================');

  const emissaoLinkSelector = 'a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao"]';
  await waitForHumanOrNavigation(page, { selector: emissaoLinkSelector, timeoutAuto: 120000 });

  // Verifica se existe toast de "Comportamento de Robô"
  try {
    // pequeno delay para o toast aparecer, se for o caso
    await page.waitForTimeout(1200);
    const toast = await page.$('#toast-container .toast-message');
    if (toast) {
      const text = await page.$eval('#toast-container .toast-message', el => el.textContent.trim());
      if (text && text.toLowerCase().includes('comportamento de robô')) {
        // salvar screenshot / log para análise
        const ts = new Date().toISOString().replace(/[:.]/g,'-');
        const img = `logs/robot-detect-${ts}.png`;
        try { await page.screenshot({ path: img, fullPage: true }); console.log(`Screenshot salvo em ${img}`);} catch(e){}
        console.log('O site identificou comportamento de robô. Recomendo usar o modo CONNECT (conectar em um Chrome humano) ou abrir manualmente o Chrome com o mesmo perfil e refazer o fluxo.');
        // fecha ou continua com fallback manual
        // opcional: await browser.close();
      }
    }
  } catch (e) {}

  // Salva cookies para próximas execuções
  await saveCookiesToFile(page, COOKIES_FILE);

  // Stage 3 em diante (mesmo fluxo)
  await page.waitForSelector(emissaoLinkSelector, { visible: true });
  await page.click(emissaoLinkSelector);
  await page.waitForSelector('#anoCalendarioSelect', { visible: true });
  await page.select('#anoCalendarioSelect', year);
  await page.evaluate(() => document.querySelector('button[type=submit]').click());

  try {
    await page.waitForSelector('#toast-container .toast-message', { timeout: 800, visible: true });
    const modalText0 = await page.$eval('#toast-container .toast-message', el => el.textContent.trim());
    if (modalText0.includes('É necessário selecionar o ano-calendário.')) {
      await browser.close();
      logger.info('Não existe informações do DAS disponível para o ano-calendário.');
      return [false, modalText0];
    }
  } catch {}

  const selectMonth = await page.waitForSelector(`[value="${year + month}"]`, { visible: true });
  await selectMonth.click();
  await page.click('#btnEmitirDas');

  try {
    await page.waitForSelector('#toast-container .toast-message', { timeout: 800, visible: true });
    const modalText1 = await page.$eval('#toast-container .toast-message', el => el.textContent.trim());
    if (modalText1.includes('Já existe pagamento para o PA') || modalText1.includes('É necessário selecionar o(s) período(s) para emissão do DAS.')) {
      const msg = modalText1.includes('Já existe pagamento para o PA') ? modalText1 : 'DAS não disponível para o período.';
      await browser.close();
      logger.info(msg);
      return [false, modalText1];
    }
  } catch {}

  await page.waitForSelector('a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/imprimir"]', { visible: true });
  await page.click('a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/imprimir"]');
  await page.waitForTimeout(1000);
  await browser.close();
}

export { scraping };