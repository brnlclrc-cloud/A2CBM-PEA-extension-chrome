// --- popup.js : Logique d'interface et d'envoi vers PEA Pro v1.1.4 ---

const URL_PROD = "https://a2cbm-pea-backend-prod.onrender.com/api";
const URL_TEST = "https://a2cbm-pea-backend-qs4v.onrender.com/api";

let isTestEnv = false;
let extractedData = null;

const fmt = (val) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(val || 0);

// Détection automatique du token depuis n'importe quel onglet PEA Pro ouvert (clé: pea_google_token)
async function autoDetectToken() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.url && (t.url.includes('192.168.') || t.url.includes('localhost') || t.url.includes('vercel.app') || t.url.includes('pea'))) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: () => localStorage.getItem('pea_google_token') || sessionStorage.getItem('pea_google_token') || localStorage.getItem('token')
        }).catch(() => []);
        
        if (results && results[0]?.result) {
          const tok = results[0].result;
          console.log("🔑 [PEA Pro Extension] Jeton détecté automatiquement depuis l'onglet:", t.url);
          chrome.storage.local.set({ savedToken: tok });
          return tok;
        }
      }
    }
  } catch (e) {
    console.warn("Auto-detect token error:", e);
  }
  return null;
}

// Fonction d'extraction universelle multi-contrats (v1.1.4)
function runMultiContractBnpExtraction() {
  const cleanNumber = (str) => {
    if (!str) return 0;
    const cleaned = String(str).replace(/[\s\u00a0\u202f€%]/g, '').replace(',', '.');
    const val = parseFloat(cleaned);
    return isNaN(val) ? 0 : val;
  };

  // 1. Extraction récursive du texte visible en sautant scripts et styles
  function getVisibleText(node) {
    if (!node) return '';
    const tag = (node.tagName || '').toUpperCase();
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'HEAD', 'META', 'LINK'].includes(tag)) {
      return '';
    }
    let text = '';
    if (node.nodeType === Node.TEXT_NODE) {
      const val = (node.nodeValue || '').trim();
      return val ? val + '\n' : '';
    }
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.childNodes) {
        text += getVisibleText(child);
      }
    }
    if (node.tagName === 'IFRAME') {
      try {
        if (node.contentDocument && node.contentDocument.body) {
          text += getVisibleText(node.contentDocument.body);
        }
      } catch (e) {}
    }
    if (node.childNodes) {
      for (const child of node.childNodes) {
        text += getVisibleText(child);
      }
    }
    return text;
  }

  const visibleText = getVisibleText(document.body);
  const lines = visibleText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.includes('tailwindcss') && !l.includes('/*') && !l.includes('*/'));

  // 2. Détection du Titulaire et du Contrat
  const holderMatch = visibleText.match(/N°\s*[0-9]+\s*\|\s*([A-Z\s-]{4,30})/i);
  const holderName = holderMatch ? holderMatch[1].trim() : '';

  const contractNameMatch = visibleText.match(/BNP\s*PARIBAS\s*MULTIPLACEMENTS\s*[0-9]*/i);
  let contractName = contractNameMatch ? contractNameMatch[0] : 'BNP Paribas Multiplacements 2';
  if (holderName) {
    contractName += ` (${holderName})`;
  }

  // 3. Détection de la Valorisation Totale ciblée (ancrée sur "Valorisation épargne")
  let totalVal = 0;
  const valBeforeMatch = visibleText.match(/((?:\d{1,3}[\s\u00a0\u202f]?\d{3})|\d+)[.,]\d{2}\s*€[\s\S]{0,100}?Valorisation\s*épargne/i);
  const valAfterMatch = visibleText.match(/Valorisation\s*épargne[\s\S]{0,100}?((?:\d{1,3}[\s\u00a0\u202f]?\d{3})|\d+)[.,]\d{2}\s*€/i);

  if (valBeforeMatch) {
    totalVal = cleanNumber(valBeforeMatch[1]);
  } else if (valAfterMatch) {
    totalVal = cleanNumber(valAfterMatch[1]);
  }

  if (!totalVal || totalVal === 0) {
    const repIdx = visibleText.indexOf('RÉPARTITION');
    const headerSnippet = repIdx !== -1 ? visibleText.substring(0, repIdx) : visibleText.substring(0, 1000);
    const headerAmounts = Array.from(headerSnippet.matchAll(/(?:(?:\d{1,3}[\s\u00a0\u202f]?\d{3})|\d+)[.,]\d{2}/g)).map(m => cleanNumber(m[0]));
    if (headerAmounts.length > 0) {
      totalVal = headerAmounts[0];
    }
  }

  // 4. Fonds en Euros
  let fondEuros = 0;
  const fePos = visibleText.toLowerCase().indexOf('fonds en euros');
  if (fePos !== -1) {
    const feSnippet = visibleText.substring(fePos, fePos + 250);
    const feEuros = Array.from(feSnippet.matchAll(/((?:\d{1,3}(?:[\s\u00a0\u202f]\d{3})*|\d+)[.,]\d{2})\s*€/g)).map(m => cleanNumber(m[1]));
    if (feEuros.length > 0) {
      fondEuros = feEuros.find(a => a > 50 && a !== 30.56 && a !== 46.61) || feEuros[0];
    }
  }

  if ((!fondEuros || fondEuros === 0) && totalVal > 0) {
    const pctMatch = visibleText.match(/Fonds\s*en\s*Euros\s*:\s*([0-9]+[.,][0-9]+)\s*%/i);
    if (pctMatch) {
      const pct = cleanNumber(pctMatch[1]);
      fondEuros = Math.round(totalVal * (pct / 100) * 100) / 100;
    }
  }

  // 5. Extraction des Unités de Compte
  const isinRegex = /[A-Z]{2}[A-Z0-9]{9}[0-9]/g;
  const isins = Array.from(new Set((visibleText.match(isinRegex) || []).map(i => i.toUpperCase())));
  const details = [];

  // A. Fonds en Euros
  if (fondEuros > 0) {
    details.push({
      support: 'Fonds en Euros',
      name: 'Fonds en Euros',
      montant: fondEuros,
      total_value: fondEuros,
      perf: 0,
      isin: 'FONDS-EUROS',
      nb_uc: 1,
      valeur_uc: fondEuros
    });
  }

  // B. Unités de Compte individuelles
  isins.forEach(isin => {
    const isinLineIdx = lines.findIndex(l => l.toUpperCase().includes(isin));
    if (isinLineIdx === -1) return;

    let name = 'Support UC';
    for (let j = isinLineIdx - 1; j >= Math.max(0, isinLineIdx - 5); j--) {
      const candidate = lines[j].replace(/PDF/gi, '').trim();
      if (candidate.length >= 4 && 
          /[a-zA-Z]/.test(candidate) &&
          !candidate.includes('€') && 
          !candidate.includes('%') && 
          !candidate.includes('Caractéristiques') && 
          !candidate.includes('Performances') && 
          !candidate.includes('RÉPARTITION') && 
          !candidate.includes('SYNTHÈSE') && 
          !/^\d+([.,]\d+)?$/.test(candidate)) {
        name = candidate;
        break;
      }
    }

    const rowBlock = lines.slice(isinLineIdx, isinLineIdx + 8).join(' ');
    const euroMatches = Array.from(rowBlock.matchAll(/((?:\d{1,3}(?:[\s\u00a0\u202f]\d{3})*|\d+)[.,]\d{2})\s*€/g)).map(m => cleanNumber(m[1]));
    const numMatches = Array.from(rowBlock.matchAll(/(\d+[.,]\d+)/g)).map(m => cleanNumber(m[1]));
    const pctMatches = Array.from(rowBlock.matchAll(/([+-]?\d+[.,]\d+)\s*%/g)).map(m => cleanNumber(m[1]));

    let totalAmount = 0;
    let unitPrice = 0;
    let qty = 0;
    let perf = pctMatches.length > 0 ? pctMatches[0] : 0;

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

    if (totalAmount > 0 && totalAmount < (totalVal || 1000000) && !details.some(d => d.isin === isin)) {
      details.push({
        support: name,
        name: name,
        montant: totalAmount,
        total_value: totalAmount,
        perf: perf,
        isin: isin,
        nb_uc: qty,
        valeur_uc: unitPrice
      });
    }
  });

  // Calcul du total UC : par définition exactement Total - Fonds Euros (100% de cohérence)
  let ucTotal = Math.max(0, Math.round((totalVal - fondEuros) * 100) / 100);

  if (!totalVal || totalVal === 0) {
    totalVal = Math.round((fondEuros + ucTotal) * 100) / 100;
  }

  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return {
    contractName,
    month: monthStr,
    totalVal,
    fondEuros,
    ucTotal,
    details,
    textPreview: lines.slice(0, 30).join(' | ')
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  const btnProd = document.getElementById('btnProd');
  const btnTest = document.getElementById('btnTest');
  const syncBtn = document.getElementById('syncBtn');
  const statusAlert = document.getElementById('statusAlert');
  const toggleSettings = document.getElementById('toggleSettings');
  const tokenSection = document.getElementById('tokenSection');
  const tokenField = document.getElementById('tokenField');
  const saveTokenBtn = document.getElementById('saveTokenBtn');
  const monthInput = document.getElementById('monthInput');
  const totalValueEl = document.getElementById('totalValue');
  const fondEurosEl = document.getElementById('fondEuros');
  const ucTotalEl = document.getElementById('ucTotal');
  const contractNameEl = document.getElementById('contractName');
  const toggleDebug = document.getElementById('toggleDebug');
  const debugBox = document.getElementById('debugBox');

  // 1. Mois actuel
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  monthInput.value = currentMonth;

  // 2. Toujours chercher en direct un token frais dans les onglets PEA Pro
  let liveToken = await autoDetectToken();
  if (liveToken) {
    tokenField.value = liveToken;
  } else {
    chrome.storage.local.get(['savedToken'], (res) => {
      if (res.savedToken) tokenField.value = res.savedToken;
    });
  }

  chrome.storage.local.get(['isTestEnv'], (res) => {
    if (res.isTestEnv !== undefined) {
      isTestEnv = res.isTestEnv;
      updateEnvButtons();
    }
  });

  function updateEnvButtons() {
    if (isTestEnv) {
      btnTest.className = 'env-btn active test';
      btnProd.className = 'env-btn';
    } else {
      btnProd.className = 'env-btn active';
      btnTest.className = 'env-btn';
    }
  }

  btnProd.onclick = () => {
    isTestEnv = false;
    updateEnvButtons();
    chrome.storage.local.set({ isTestEnv: false });
  };

  btnTest.onclick = () => {
    isTestEnv = true;
    updateEnvButtons();
    chrome.storage.local.set({ isTestEnv: true });
  };

  toggleSettings.onclick = () => {
    tokenSection.style.display = tokenSection.style.display === 'none' ? 'block' : 'none';
  };

  toggleDebug.onclick = () => {
    debugBox.style.display = debugBox.style.display === 'none' ? 'block' : 'none';
  };

  saveTokenBtn.onclick = () => {
    chrome.storage.local.set({ savedToken: tokenField.value.trim() }, () => {
      showAlert("Jeton enregistré avec succès !", "success");
      setTimeout(() => { statusAlert.style.display = 'none'; }, 2000);
    });
  };

  // 3. Analyse propre du DOM
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: runMultiContractBnpExtraction
      }).catch(err => {
        console.error("Injection error:", err);
      });

      const response = results && results[0]?.result;

      if (!response) {
        contractNameEl.innerText = "Erreur de lecture";
        showAlert("Impossible d'accéder aux données de cet onglet.", "error");
        return;
      }

      extractedData = response;
      contractNameEl.innerText = response.contractName || "BNP Multiplacements 2";
      totalValueEl.innerText = fmt(response.totalVal);
      fondEurosEl.innerText = fmt(response.fondEuros);
      
      const ucCount = response.details.filter(d => d.isin !== 'FONDS-EUROS').length;
      ucTotalEl.innerText = ucCount > 0 
        ? `${ucCount} UC (${fmt(response.ucTotal)})`
        : `Gestion Pilotée (${fmt(response.ucTotal)})`;
      
      if (response.textPreview) {
        debugBox.value = `[Lignes détectées]\n${response.textPreview}`;
      }

      if (response.totalVal > 0) {
        syncBtn.disabled = false;
        statusAlert.style.display = 'none';
      }
    }
  } catch (err) {
    console.error("Erreur globale:", err);
  }

  // 4. Synchronisation vers l'API PEA Pro
  syncBtn.onclick = async () => {
    if (!extractedData || extractedData.totalVal === 0) return;

    syncBtn.disabled = true;
    syncBtn.innerHTML = `<span>⏳</span> Synchronisation...`;
    statusAlert.style.display = 'none';

    // Récupération en direct du jeton le plus récent
    let token = await autoDetectToken();
    if (!token) {
      const storageRes = await chrome.storage.local.get(['savedToken']);
      token = storageRes.savedToken;
    }

    if (!token) {
      showAlert("❌ Jeton manquant : ouvrez PEA Pro dans un onglet ou collez votre jeton dans ⚙️.", "error");
      syncBtn.disabled = false;
      syncBtn.innerHTML = `<span>🚀</span> Réessayer la synchronisation`;
      tokenSection.style.display = 'block';
      return;
    }

    const apiUrl = isTestEnv ? URL_TEST : URL_PROD;
    const targetMonth = monthInput.value || currentMonth;

    try {
      const payload = {
        action: 'addAVSnapshot',
        month: targetMonth,
        total_value: extractedData.totalVal,
        fond_euros: extractedData.fondEuros,
        unites_compte: extractedData.ucTotal,
        details: extractedData.details,
        monthly_transfer: 0,
        token: token
      };

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (data.success) {
        showAlert(`✅ Relevé de ${targetMonth} (${fmt(extractedData.totalVal)}) synchronisé avec succès !`, "success");
        syncBtn.innerHTML = `<span>✅</span> Synchronisé !`;
      } else {
        // En cas de jeton expiré, on vide le cache et on guide l'utilisateur
        if (data.error && (data.error.includes('Jeton') || data.error.includes('expiré') || data.error.includes('invalide'))) {
          chrome.storage.local.remove(['savedToken']);
          showAlert(`❌ Session expirée : faites F5 dans votre onglet PEA Pro, puis recliquez ici.`, "error");
        } else {
          showAlert(`❌ Erreur API : ${data.error || 'Vérifiez votre session.'}`, "error");
        }
        syncBtn.disabled = false;
        syncBtn.innerHTML = `<span>🚀</span> Réessayer la synchronisation`;
      }
    } catch (e) {
      showAlert(`❌ Échec réseau : ${e.message}`, "error");
      syncBtn.disabled = false;
      syncBtn.innerHTML = `<span>🚀</span> Réessayer la synchronisation`;
    }
  };

  function showAlert(msg, type) {
    statusAlert.innerText = msg;
    statusAlert.className = `alert ${type}`;
    statusAlert.style.display = 'block';
  }
});
