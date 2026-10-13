// --- popup.js : Logique d'interface et d'envoi vers PEA Pro v1.1.8 ---

// URLs avec Cloud Run en primaire et Render en secours
const URLS_PROD = [
  "https://a2cbm-pea-backend-prod-217698785901.europe-west9.run.app/api",
  "https://a2cbm-pea-backend-prod.onrender.com/api",
  "https://backup-prod-a2cbm-pea-backend.onrender.com/api"
];

const URLS_TEST = [
  "https://a2cbm-pea-backend-test-217698785901.europe-west9.run.app/api",
  "https://a2cbm-pea-backend-qs4v.onrender.com/api",
  "https://backuo-a2cbm-pea-backend.onrender.com/api"
];

let isTestEnv = false;
let extractedData = null;

const fmt = (val) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(val || 0);

// Décodage et inspection JWT (Google ID Token)
function parseJwt(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.trim().split('.');
    if (parts.length < 2) return null;
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    try {
      let base64 = token.trim().split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      return JSON.parse(atob(base64));
    } catch (e2) {
      return null;
    }
  }
}

function checkTokenValidity(token) {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return { valid: false, message: "Aucun jeton configuré" };
  }
  const payload = parseJwt(token);
  if (!payload || !payload.exp) {
    return { valid: false, message: "Format de jeton invalide (non JWT)" };
  }
  const now = Math.floor(Date.now() / 1000);
  const remainingSeconds = payload.exp - now;
  const expDate = new Date(payload.exp * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const email = payload.email || 'Utilisateur';

  if (remainingSeconds <= 0) {
    return {
      valid: false,
      message: `Jeton expiré depuis ${expDate} (${email})`,
      email,
      exp: payload.exp
    };
  }

  const mins = Math.floor(remainingSeconds / 60);
  return {
    valid: true,
    message: `Valide encore ${mins} min (jusqu'à ${expDate} - ${email})`,
    email,
    exp: payload.exp
  };
}

// Envoi avec basculement automatique Cloud Run -> Render
async function sendSnapshotWithFallback(urls, payload, token) {
  let lastError = null;
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const headers = { 
        'Content-Type': 'application/json' 
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await res.json().catch(() => null);
      if (!data) {
        throw new Error(`Réponse vide ou invalide (HTTP ${res.status})`);
      }
      return data;
    } catch (e) {
      console.warn(`[PEA Pro Extension] Échec avec ${url} (${e.message}), bascule sur secours...`);
      lastError = e;
    }
  }
  throw lastError || new Error("Tous les serveurs sont injoignables");
}

// Détection automatique du token depuis n'importe quel onglet PEA Pro ouvert (clé: pea_google_token)
async function autoDetectToken() {
  try {
    const tabs = await chrome.tabs.query({});
    const candidates = [];

    for (const t of tabs) {
      if (!t.url || t.url.startsWith('chrome://') || t.url.startsWith('chrome-extension://') || t.url.startsWith('edge://') || t.url.startsWith('about:')) {
        continue;
      }
      const isPeaTab = (t.url.includes('192.168.') || t.url.includes('localhost') || t.url.includes('vercel.app') || t.url.includes('pea')) ||
                       (t.title && t.title.toLowerCase().includes('pea'));
      if (!isPeaTab) continue;

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: () => localStorage.getItem('pea_google_token') || sessionStorage.getItem('pea_google_token') || localStorage.getItem('token')
        });

        const tok = results && results[0]?.result;
        if (tok) {
          const validity = checkTokenValidity(tok);
          candidates.push({
            token: tok,
            validity,
            tabUrl: t.url,
            tabTitle: t.title,
            tabId: t.id
          });
        }
      } catch (errScript) {
        // Ignorer silencieusement si l'onglet est suspendu ou inaccessible
      }
    }

    // Priorité 1 : Le candidat valide avec la plus longue durée de vie restante
    const validCandidates = candidates.filter(c => c.validity.valid);
    if (validCandidates.length > 0) {
      validCandidates.sort((a, b) => (b.validity.exp || 0) - (a.validity.exp || 0));
      const best = validCandidates[0];
      console.log("🔑 [PEA Pro Extension] Jeton VALIDE détecté depuis:", best.tabUrl, best.validity.message);
      chrome.storage.local.set({ savedToken: best.token });
      return { token: best.token, validity: best.validity, source: 'tab' };
    }

    // Si on a trouvé des onglets mais uniquement avec des jetons expirés
    if (candidates.length > 0) {
      candidates.sort((a, b) => (b.validity.exp || 0) - (a.validity.exp || 0));
      const latestExpired = candidates[0];
      console.warn("⚠️ [PEA Pro Extension] Jeton trouvé mais EXPIRÉ:", latestExpired.validity.message);
      return { token: null, validity: latestExpired.validity, expiredCandidate: latestExpired.token, source: 'tab_expired' };
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
  const openPeaProBtn = document.getElementById('openPeaProBtn');
  const toggleSettings = document.getElementById('toggleSettings');
  const tokenSection = document.getElementById('tokenSection');
  const tokenField = document.getElementById('tokenField');
  const tokenStatusText = document.getElementById('tokenStatusText');
  const saveTokenBtn = document.getElementById('saveTokenBtn');
  const monthInput = document.getElementById('monthInput');
  const totalValueEl = document.getElementById('totalValue');
  const fondEurosEl = document.getElementById('fondEuros');
  const ucTotalEl = document.getElementById('ucTotal');
  const contractNameEl = document.getElementById('contractName');
  const toggleDebug = document.getElementById('toggleDebug');
  const debugBox = document.getElementById('debugBox');

  // Mise à jour de l'indicateur visuel d'état du jeton
  function updateTokenStatusUI(tok) {
    if (!tokenStatusText) return;
    const v = checkTokenValidity(tok);
    if (!tok || !tok.trim()) {
      tokenStatusText.innerText = "⚪ Aucun jeton configuré";
      tokenStatusText.style.color = "#94a3b8";
    } else if (v.valid) {
      tokenStatusText.innerText = `🟢 ${v.message}`;
      tokenStatusText.style.color = "#34d399";
    } else {
      tokenStatusText.innerText = `🔴 ${v.message}`;
      tokenStatusText.style.color = "#f87171";
    }
    return v;
  }

  // 1. Mois actuel
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  monthInput.value = currentMonth;

  // 2. Détection intelligente du jeton au démarrage
  const detection = await autoDetectToken();
  if (detection && detection.token) {
    tokenField.value = detection.token;
    updateTokenStatusUI(detection.token);
  } else {
    chrome.storage.local.get(['savedToken'], (res) => {
      const tok = res.savedToken || detection?.expiredCandidate || '';
      if (tok) {
        tokenField.value = tok;
        updateTokenStatusUI(tok);
      }
    });
  }

  tokenField.addEventListener('input', () => {
    updateTokenStatusUI(tokenField.value.trim());
  });

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
    const val = tokenField.value.trim();
    const validity = updateTokenStatusUI(val);
    chrome.storage.local.set({ savedToken: val }, () => {
      if (validity.valid) {
        showAlert(`✅ Jeton valide enregistré (${validity.message})`, "success");
      } else {
        showAlert(`⚠️ Jeton enregistré mais inactif : ${validity.message}`, "info");
      }
      setTimeout(() => { statusAlert.style.display = 'none'; }, 2500);
    });
  };

  // Bouton d'ouverture ou rafraîchissement rapide de PEA Pro
  if (openPeaProBtn) {
    openPeaProBtn.onclick = async () => {
      try {
        const tabs = await chrome.tabs.query({});
        const peaTab = tabs.find(t => t.url && (t.url.includes('a2-cbm-pea.vercel.app') || t.url.includes('localhost') || (t.title && t.title.toLowerCase().includes('pea'))));
        if (peaTab && peaTab.id) {
          await chrome.tabs.update(peaTab.id, { active: true });
          if (peaTab.windowId) await chrome.windows.update(peaTab.windowId, { focused: true });
          chrome.tabs.reload(peaTab.id);
        } else {
          chrome.tabs.create({ url: "https://a2-cbm-pea.vercel.app" });
        }
      } catch (e) {
        chrome.tabs.create({ url: "https://a2-cbm-pea.vercel.app" });
      }
    };
  }

  // 3. Analyse sécurisée du DOM
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.id) {
      contractNameEl.innerText = "Aucun onglet";
      showAlert("ℹ️ Aucun onglet actif détecté.", "info");
      return;
    }

    const tabUrl = tab.url || '';

    // Sécurité : Ne jamais tenter d'injecter du code sur les pages système du navigateur (chrome://, edge://, about:)
    const isSystemUrl = tabUrl.startsWith('chrome://') || 
                        tabUrl.startsWith('chrome-extension://') || 
                        tabUrl.startsWith('edge://') || 
                        tabUrl.startsWith('about:') || 
                        tabUrl.startsWith('view-source:') ||
                        tabUrl.startsWith('devtools://');

    if (isSystemUrl) {
      contractNameEl.innerText = "Page système Chrome";
      showAlert("ℹ️ Ouvrez l'onglet de votre contrat d'Assurance Vie sur BNP Paribas pour synchroniser.", "info");
      syncBtn.disabled = true;
      return;
    }

    // Si on n'est pas sur le site BNP Paribas
    const isBnpPage = tabUrl.includes('bnpparibas');
    if (!isBnpPage) {
      contractNameEl.innerText = "Hors BNP Paribas";
      showAlert("ℹ️ Rendez-vous sur votre espace mabanque.bnpparibas pour synchroniser.", "info");
      syncBtn.disabled = true;
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runMultiContractBnpExtraction
    }).catch(err => {
      console.warn("[PEA Pro Extension] Avertissement injection :", err?.message || err);
      return null;
    });

    const response = results && results[0]?.result;

    if (!response) {
      contractNameEl.innerText = "Lecture du contrat...";
      showAlert("Impossible de lire les données : assurez-vous d'être sur la page du contrat BNP.", "error");
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
    } else {
      syncBtn.disabled = true;
      showAlert("ℹ️ Naviguez sur la page de votre contrat BNP pour détecter les montants.", "info");
    }
  } catch (err) {
    console.warn("[PEA Pro Extension] Avertissement analyse :", err?.message || err);
  }

  // 4. Synchronisation vers l'API PEA Pro
  syncBtn.onclick = async () => {
    if (!extractedData || extractedData.totalVal === 0) return;

    syncBtn.disabled = true;
    syncBtn.innerHTML = `<span>⏳</span> Synchronisation...`;
    statusAlert.style.display = 'none';
    if (openPeaProBtn) openPeaProBtn.style.display = 'none';

    // Recherche d'un jeton valide (en direct d'abord, puis manuel, puis stocké)
    let token = null;
    let tokenValidity = null;

    const liveDetect = await autoDetectToken();
    if (liveDetect && liveDetect.token) {
      token = liveDetect.token;
      tokenValidity = liveDetect.validity;
      tokenField.value = token;
      updateTokenStatusUI(token);
    }

    if (!token && tokenField.value.trim()) {
      const manualVal = checkTokenValidity(tokenField.value.trim());
      if (manualVal.valid) {
        token = tokenField.value.trim();
        tokenValidity = manualVal;
        chrome.storage.local.set({ savedToken: token });
      } else {
        tokenValidity = manualVal;
      }
    }

    if (!token) {
      const storageRes = await chrome.storage.local.get(['savedToken']);
      if (storageRes.savedToken) {
        const storedVal = checkTokenValidity(storageRes.savedToken);
        if (storedVal.valid) {
          token = storageRes.savedToken;
          tokenValidity = storedVal;
          tokenField.value = token;
          updateTokenStatusUI(token);
        } else if (!tokenValidity) {
          tokenValidity = storedVal;
        }
      }
    }

    // Si aucun jeton valide n'a pu être trouvé
    if (!token) {
      const reasonMsg = tokenValidity?.message || "Aucun jeton valide";
      showAlert(`❌ Session expirée ou introuvable : ${reasonMsg}.\nCliquez ci-dessous pour ouvrir PEA Pro et vous reconnecter.`, "error");
      syncBtn.disabled = false;
      syncBtn.innerHTML = `<span>🚀</span> Réessayer la synchronisation`;
      tokenSection.style.display = 'block';
      if (openPeaProBtn) openPeaProBtn.style.display = 'flex';
      return;
    }

    const targetUrls = isTestEnv ? URLS_TEST : URLS_PROD;
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

      const data = await sendSnapshotWithFallback(targetUrls, payload, token);

      if (data && data.success) {
        showAlert(`✅ Relevé de ${targetMonth} (${fmt(extractedData.totalVal)}) synchronisé avec succès !`, "success");
        syncBtn.innerHTML = `<span>✅</span> Synchronisé !`;
      } else {
        const errorMsg = data?.error || 'Erreur inattendue du serveur.';
        if (errorMsg.includes('Jeton') || errorMsg.includes('expiré') || errorMsg.includes('invalide')) {
          chrome.storage.local.remove(['savedToken']);
          showAlert(`❌ Session refusée par le serveur : ${errorMsg}.\nRechargez PEA Pro pour régénérer votre session Google.`, "error");
          if (openPeaProBtn) openPeaProBtn.style.display = 'flex';
        } else {
          showAlert(`❌ Erreur API : ${errorMsg}`, "error");
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
