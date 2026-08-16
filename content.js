// --- content.js : Extracteur Robuste BNP Paribas v1.0.3 ---

function cleanNumber(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[\s\u00a0\u202f€%]/g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

function extractBnpData() {
  const fullText = document.body.innerText || document.documentElement.innerText || '';

  const isinRegex = /[A-Z]{2}[A-Z0-9]{9}[0-9]/g;
  const isins = Array.from(new Set(fullText.match(isinRegex) || []));
  const details = [];

  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);

  isins.forEach(isin => {
    const idx = lines.findIndex(l => l.includes(isin));
    let name = 'Support UC';
    if (idx !== -1) {
      for (let j = idx - 1; j >= Math.max(0, idx - 4); j--) {
        const candidate = lines[j].replace(/PDF/gi, '').trim();
        if (candidate && !candidate.includes('€') && !candidate.includes('%') && !candidate.includes('Nb UC')) {
          name = candidate;
          break;
        }
      }
    }

    const pos = fullText.indexOf(isin);
    const snippet = pos !== -1 ? fullText.substring(Math.max(0, pos - 100), Math.min(fullText.length, pos + 250)) : '';

    const euroMatches = Array.from(snippet.matchAll(/([0-9\s\u00a0\u202f]+[.,][0-9]{2})\s*€/g)).map(m => cleanNumber(m[1]));
    const numMatches = Array.from(snippet.matchAll(/([0-9]+[.,][0-9]+)/g)).map(m => cleanNumber(m[1]));

    let totalAmount = 0;
    let unitPrice = 0;
    let qty = 0;

    if (euroMatches.length >= 2) {
      unitPrice = euroMatches[0];
      totalAmount = euroMatches[euroMatches.length - 1];
    } else if (euroMatches.length === 1) {
      totalAmount = euroMatches[0];
    } else if (numMatches.length >= 2) {
      totalAmount = numMatches[numMatches.length - 1];
      unitPrice = numMatches[0];
    }

    qty = numMatches.find(n => n !== totalAmount && n !== unitPrice && n > 0) || 0;

    if (totalAmount > 0 && !details.some(d => d.isin === isin)) {
      details.push({
        name: name,
        isin: isin,
        qty: qty,
        unit_price: unitPrice,
        total_value: totalAmount
      });
    }
  });

  let fondEuros = 0;
  const fePos = fullText.toLowerCase().indexOf('fonds en euros');
  if (fePos !== -1) {
    const feSnippet = fullText.substring(fePos, fePos + 250);
    const feEuros = Array.from(feSnippet.matchAll(/([0-9\s\u00a0\u202f]+[.,][0-9]{2})\s*€/g)).map(m => cleanNumber(m[1]));
    if (feEuros.length > 0) {
      fondEuros = feEuros.find(a => a > 100 && a !== 30.56) || feEuros[0];
    }
  }

  const ucTotal = Math.round(details.reduce((sum, d) => sum + d.total_value, 0) * 100) / 100;

  let totalVal = 0;
  const valPos = fullText.toLowerCase().indexOf('valorisation');
  if (valPos !== -1) {
    const valSnippet = fullText.substring(Math.max(0, valPos - 150), Math.min(fullText.length, valPos + 150));
    const valEuros = Array.from(valSnippet.matchAll(/([0-9\s\u00a0\u202f]+[.,][0-9]{2})\s*€/g)).map(m => cleanNumber(m[1]));
    if (valEuros.length > 0) {
      totalVal = valEuros[0];
    }
  }

  if (!totalVal || totalVal < 100) {
    totalVal = Math.round((fondEuros + ucTotal) * 100) / 100;
  }

  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const contractNameMatch = fullText.match(/BNP\s*PARIBAS\s*MULTIPLACEMENTS\s*[0-9]*/i);
  const contractName = contractNameMatch ? contractNameMatch[0] : 'BNP Paribas Multiplacements 2';

  return {
    contractName,
    month: monthStr,
    totalVal,
    fondEuros,
    ucTotal,
    details
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extract_bnp_data') {
    const result = extractBnpData();
    sendResponse(result);
  }
  return true;
});
