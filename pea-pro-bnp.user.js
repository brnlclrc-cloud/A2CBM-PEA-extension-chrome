// ==UserScript==
// @name         PEA Pro - Sync Assurance Vie BNP
// @namespace    http://tampermonkey.net/
// @version      1.1.5
// @description  Synchronisation automatique de votre Assurance Vie BNP Paribas vers PEA Pro (Version Tampermonkey).
// @author       Bruno
// @match        https://*.mabanque.bnpparibas/*  <!-- ⚠️ À REMPLACER PAR L'URL EXACTE DE LA BANQUE -->
// @match        https://*.bnpparibas.com/*       <!-- ⚠️ À REMPLACER PAR L'URL EXACTE DE LA BANQUE -->
// @match        https://a2cbm-pea-backend-prod.onrender.com/*
// @match        https://a2cbm-pea-backend-qs4v.onrender.com/*
// @match        https://*.vercel.app/*
// @match        http://localhost:*/*
// @updateURL    https://raw.githubusercontent.com/TON_USER/TON_REPO/main/pea-pro-bnp.user.js <!-- ⚠️ TON LIEN GITHUB RAW -->
// @downloadURL  https://raw.githubusercontent.com/TON_USER/TON_REPO/main/pea-pro-bnp.user.js <!-- ⚠️ TON LIEN GITHUB RAW -->
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. CAPTURE DU TOKEN SUR L'APP PEA PRO
    // ==========================================
    const currentUrl = window.location.href;
    const isPeaApp = currentUrl.includes('localhost') || currentUrl.includes('vercel.app') || currentUrl.includes('onrender') || currentUrl.includes('pea');

    if (isPeaApp) {
        // On est sur l'app PEA : on capture le token et on s'arrête là (pas d'interface injectée)
        const token = localStorage.getItem('pea_google_token') || sessionStorage.getItem('pea_google_token') || localStorage.getItem('token');
        if (token) {
            GM_setValue('savedToken', token);
            console.log("🔑 [PEA Pro Extension] Jeton mis à jour dans Tampermonkey !");
        }
        return; 
    }

    // ==========================================
    // 2. FONCTIONS DE LOGIQUE (Ex-popup.js)
    // ==========================================
    const URL_PROD = "https://a2cbm-pea-backend-prod.onrender.com/api";
    const URL_TEST = "https://a2cbm-pea-backend-qs4v.onrender.com/api";
    const fmt = (val) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(val || 0);

    // Extraction universelle (inchangée depuis ton popup.js v1.1.4)
    function runMultiContractBnpExtraction() {
        const cleanNumber = (str) => {
            if (!str) return 0;
            const cleaned = String(str).replace(/[\s\u00a0\u202f€%]/g, '').replace(',', '.');
            const val = parseFloat(cleaned);
            return isNaN(val) ? 0 : val;
        };

        function getVisibleText(node) {
            if (!node) return '';
            const tag = (node.tagName || '').toUpperCase();
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'HEAD', 'META', 'LINK'].includes(tag)) return '';
            
            let text = '';
            if (node.nodeType === Node.TEXT_NODE) {
                const val = (node.nodeValue || '').trim();
                return val ? val + '\n' : '';
            }
            if (node.shadowRoot) {
                for (const child of node.shadowRoot.childNodes) text += getVisibleText(child);
            }
            if (node.tagName === 'IFRAME') {
                try { if (node.contentDocument && node.contentDocument.body) text += getVisibleText(node.contentDocument.body); } catch (e) {}
            }
            if (node.childNodes) {
                for (const child of node.childNodes) text += getVisibleText(child);
            }
            return text;
        }

        const visibleText = getVisibleText(document.body);
        const lines = visibleText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.includes('tailwindcss') && !l.includes('/*') && !l.includes('*/'));

        const holderMatch = visibleText.match(/N°\s*[0-9]+\s*\|\s*([A-Z\s-]{4,30})/i);
        const holderName = holderMatch ? holderMatch[1].trim() : '';

        const contractNameMatch = visibleText.match(/BNP\s*PARIBAS\s*MULTIPLACEMENTS\s*[0-9]*/i);
        let contractName = contractNameMatch ? contractNameMatch[0] : 'BNP Paribas Multiplacements 2';
        if (holderName) contractName += ` (${holderName})`;

        let totalVal = 0;
        const valBeforeMatch = visibleText.match(/((?:\d{1,3}[\s\u00a0\u202f]?\d{3})|\d+)[.,]\d{2}\s*€[\s\S]{0,100}?Valorisation\s*épargne/i);
        const valAfterMatch = visibleText.match(/Valorisation\s*épargne[\s\S]{0,100}?((?:\d{1,3}[\s\u00a0\u202f]?\d{3})|\d+)[.,]\d{2}\s*€/i);

        if (valBeforeMatch) totalVal = cleanNumber(valBeforeMatch[1]);
        else if (valAfterMatch) totalVal = cleanNumber(valAfterMatch[1]);

        if (!totalVal || totalVal === 0) {
            const repIdx = visibleText.indexOf('RÉPARTITION');
            const headerSnippet = repIdx !== -1 ? visibleText.substring(0, repIdx) : visibleText.substring(0, 1000);
            const headerAmounts = Array.from(headerSnippet.matchAll(/(?:(?:\d{1,3}[\s\u00a0\u202f]?\d{3})|\d+)[.,]\d{2}/g)).map(m => cleanNumber(m[0]));
            if (headerAmounts.length > 0) totalVal = headerAmounts[0];
        }

        let fondEuros = 0;
        const fePos = visibleText.toLowerCase().indexOf('fonds en euros');
        if (fePos !== -1) {
            const feSnippet = visibleText.substring(fePos, fePos + 250);
            const feEuros = Array.from(feSnippet.matchAll(/((?:\d{1,3}(?:[\s\u00a0\u202f]\d{3})*|\d+)[.,]\d{2})\s*€/g)).map(m => cleanNumber(m[1]));
            if (feEuros.length > 0) fondEuros = feEuros.find(a => a > 50 && a !== 30.56 && a !== 46.61) || feEuros[0];
        }

        if ((!fondEuros || fondEuros === 0) && totalVal > 0) {
            const pctMatch = visibleText.match(/Fonds\s*en\s*Euros\s*:\s*([0-9]+[.,][0-9]+)\s*%/i);
            if (pctMatch) {
                const pct = cleanNumber(pctMatch[1]);
                fondEuros = Math.round(totalVal * (pct / 100) * 100) / 100;
            }
        }

        const isinRegex = /[A-Z]{2}[A-Z0-9]{9}[0-9]/g;
        const isins = Array.from(new Set((visibleText.match(isinRegex) || []).map(i => i.toUpperCase())));
        const details = [];

        if (fondEuros > 0) {
            details.push({ support: 'Fonds en Euros', name: 'Fonds en Euros', montant: fondEuros, total_value: fondEuros, perf: 0, isin: 'FONDS-EUROS', nb_uc: 1, valeur_uc: fondEuros });
        }

        isins.forEach(isin => {
            const isinLineIdx = lines.findIndex(l => l.toUpperCase().includes(isin));
            if (isinLineIdx === -1) return;

            let name = 'Support UC';
            for (let j = isinLineIdx - 1; j >= Math.max(0, isinLineIdx - 5); j--) {
                const candidate = lines[j].replace(/PDF/gi, '').trim();
                if (candidate.length >= 4 && /[a-zA-Z]/.test(candidate) && !candidate.includes('€') && !candidate.includes('%') && !candidate.includes('Caractéristiques') && !candidate.includes('Performances') && !candidate.includes('RÉPARTITION') && !candidate.includes('SYNTHÈSE') && !/^\d+([.,]\d+)?$/.test(candidate)) {
                    name = candidate;
                    break;
                }
            }

            const rowBlock = lines.slice(isinLineIdx, isinLineIdx + 8).join(' ');
            const euroMatches = Array.from(rowBlock.matchAll(/((?:\d{1,3}(?:[\s\u00a0\u202f]\d{3})*|\d+)[.,]\d{2})\s*€/g)).map(m => cleanNumber(m[1]));
            const numMatches = Array.from(rowBlock.matchAll(/(\d+[.,]\d+)/g)).map(m => cleanNumber(m[1]));
            const pctMatches = Array.from(rowBlock.matchAll(/([+-]?\d+[.,]\d+)\s*%/g)).map(m => cleanNumber(m[1]));

            let totalAmount = 0, unitPrice = 0, qty = 0, perf = pctMatches.length > 0 ? pctMatches[0] : 0;

            if (euroMatches.length >= 2) { unitPrice = euroMatches[0]; totalAmount = euroMatches[euroMatches.length - 1]; } 
            else if (euroMatches.length === 1) { totalAmount = euroMatches[0]; } 
            else if (numMatches.length >= 2) { totalAmount = numMatches[numMatches.length - 1]; unitPrice = numMatches[0]; }

            qty = numMatches.find(n => n !== totalAmount && n !== unitPrice && n > 0) || 0;

            if (totalAmount > 0 && totalAmount < (totalVal || 1000000) && !details.some(d => d.isin === isin)) {
                details.push({ support: name, name: name, montant: totalAmount, total_value: totalAmount, perf: perf, isin: isin, nb_uc: qty, valeur_uc: unitPrice });
            }
        });

        let ucTotal = Math.max(0, Math.round((totalVal - fondEuros) * 100) / 100);
        if (!totalVal || totalVal === 0) totalVal = Math.round((fondEuros + ucTotal) * 100) / 100;

        const now = new Date();
        const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        return { contractName, month: monthStr, totalVal, fondEuros, ucTotal, details, textPreview: lines.slice(0, 30).join(' | ') };
    }

    // ==========================================
    // 3. INJECTION DE L'INTERFACE (Shadow DOM)
    // ==========================================
    const uiContainer = document.createElement('div');
    uiContainer.id = 'pea-pro-tampermonkey-root';
    uiContainer.style.position = 'fixed';
    uiContainer.style.bottom = '20px';
    uiContainer.style.right = '20px';
    uiContainer.style.zIndex = '9999999';
    document.body.appendChild(uiContainer);

    const shadow = uiContainer.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .panel { width: 360px; background: #0B1120; color: #E2E8F0; padding: 16px; font-size: 13px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); }
        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px; cursor: pointer; }
        .title { font-size: 15px; font-weight: 800; color: #60A5FA; display: flex; align-items: center; gap: 6px; }
        .version { font-size: 10px; background: rgba(59, 130, 246, 0.15); color: #93C5FD; padding: 2px 6px; border-radius: 99px; border: 1px solid rgba(59, 130, 246, 0.3); }
        
        .card { background: #151C2C; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 14px; margin-bottom: 12px; }
        .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
        .row:last-child { margin-bottom: 0; }
        .label { color: #94A3B8; font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; flex-shrink: 0; }
        .value { font-weight: 700; font-size: 13px; color: #FFFFFF; font-family: ui-monospace, monospace; text-align: right; word-break: break-word; }
        .value-total { color: #34D399; font-size: 16px; font-weight: 800; }

        .env-toggle { display: flex; gap: 6px; background: #0F172A; padding: 3px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.06); margin-bottom: 12px; }
        .env-btn { flex: 1; padding: 6px; border-radius: 7px; border: none; font-size: 11px; font-weight: 700; cursor: pointer; background: transparent; color: #94A3B8; transition: all 0.2s; }
        .env-btn.active { background: #2563EB; color: #FFFFFF; box-shadow: 0 2px 8px rgba(37,99,235,0.4); }
        .env-btn.active.test { background: #D97706; box-shadow: 0 2px 8px rgba(217,119,6,0.4); }

        .sync-btn { width: 100%; padding: 12px; background: linear-gradient(135deg, #2563EB, #1D4ED8); border: none; border-radius: 12px; color: #FFFFFF; font-weight: 800; font-size: 13px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 14px rgba(37,99,235,0.3); }
        .sync-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(37,99,235,0.4); }
        .sync-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

        .alert { padding: 10px; border-radius: 10px; font-size: 11px; text-align: center; margin-top: 10px; display: none; line-height: 1.4; }
        .alert.success { background: rgba(16,185,129,0.15); border: 1px solid #10B981; color: #34D399; }
        .alert.error { background: rgba(239,68,68,0.15); border: 1px solid #EF4444; color: #F87171; }
        
        .settings-link { font-size: 11px; color: #64748B; text-align: center; margin-top: 10px; cursor: pointer; text-decoration: underline; }
        .token-input { width: 100%; padding: 8px; background: #0F172A; border: 1px solid #334155; border-radius: 8px; color: #FFF; font-size: 11px; margin-top: 6px; }
        
        #panelContent { display: block; }
        .minimized #panelContent { display: none; }
      </style>

      <div class="panel" id="mainPanel">
        <div class="header" id="toggleCollapse">
          <div class="title"><span>📈</span> PEA Pro Sync</div>
          <div class="version">v1.1.5 (UserScript) <span>▼</span></div>
        </div>
        
        <div id="panelContent">
            <div class="env-toggle">
              <button id="btnProd" class="env-btn active">🚀 Production</button>
              <button id="btnTest" class="env-btn">🧪 Test (Dev)</button>
            </div>

            <div id="dataCard" class="card">
              <div class="row">
                <span class="label">Contrat</span>
                <span id="contractName" class="value" style="font-size:11px;max-width:210px;">Recherche...</span>
              </div>
              <div class="row">
                <span class="label">Mois</span>
                <input type="month" id="monthInput" style="background:#0F172A;border:1px solid #334155;color:#FFF;border-radius:6px;padding:2px 6px;font-size:11px;font-weight:bold;outline:none;">
              </div>
              <div class="row" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">
                <span class="label">Valorisation</span>
                <span id="totalValue" class="value value-total">0,00 €</span>
              </div>
              <div class="row">
                <span class="label">Fonds Euros</span>
                <span id="fondEuros" class="value">0,00 €</span>
              </div>
              <div class="row">
                <span class="label">Unités de Compte</span>
                <span id="ucTotal" class="value">0 ligne (0 €)</span>
              </div>
            </div>

            <button id="syncBtn" class="sync-btn" disabled>
              <span>🚀</span> Synchroniser avec PEA Pro
            </button>

            <div id="statusAlert" class="alert"></div>

            <div id="tokenSection" style="display:none;margin-top:12px;padding:10px;background:#0F172A;border-radius:10px;border:1px solid #334155;">
              <span class="label">Jeton manuel</span>
              <input type="text" id="tokenField" placeholder="Collez votre token ici si besoin..." class="token-input">
              <button id="saveTokenBtn" style="margin-top:6px;width:100%;padding:6px;background:#334155;color:#FFF;border:none;border-radius:6px;font-size:11px;font-weight:bold;cursor:pointer;">Enregistrer</button>
            </div>

            <div id="toggleSettings" class="settings-link">⚙️ Configurer le Jeton</div>
            <div id="toggleDebug" class="settings-link" style="color:#38bdf8;margin-top:6px;">🔍 Voir le texte détecté</div>
            <textarea id="debugBox" readonly style="display:none;width:100%;height:100px;background:#0f172a;color:#94a3b8;font-size:10px;border:1px solid #334155;border-radius:6px;margin-top:6px;padding:6px;font-family:monospace;resize:none;"></textarea>
        </div>
      </div>
    `;

    // ==========================================
    // 4. ANIMATION DE L'INTERFACE
    // ==========================================
    const $ = (selector) => shadow.querySelector(selector);
    
    let isTestEnv = GM_getValue('isTestEnv', false);
    let extractedData = null;

    $('#toggleCollapse').onclick = () => {
        $('#mainPanel').classList.toggle('minimized');
    };

    function updateEnvButtons() {
        if (isTestEnv) {
            $('#btnTest').className = 'env-btn active test';
            $('#btnProd').className = 'env-btn';
        } else {
            $('#btnProd').className = 'env-btn active';
            $('#btnTest').className = 'env-btn';
        }
    }
    updateEnvButtons();

    $('#btnProd').onclick = () => { isTestEnv = false; updateEnvButtons(); GM_setValue('isTestEnv', false); };
    $('#btnTest').onclick = () => { isTestEnv = true; updateEnvButtons(); GM_setValue('isTestEnv', true); };
    $('#toggleSettings').onclick = () => { $('#tokenSection').style.display = $('#tokenSection').style.display === 'none' ? 'block' : 'none'; };
    $('#toggleDebug').onclick = () => { $('#debugBox').style.display = $('#debugBox').style.display === 'none' ? 'block' : 'none'; };

    const savedToken = GM_getValue('savedToken', '');
    if (savedToken) $('#tokenField').value = savedToken;

    $('#saveTokenBtn').onclick = () => {
        GM_setValue('savedToken', $('#tokenField').value.trim());
        showAlert("Jeton enregistré !", "success");
        setTimeout(() => { $('#statusAlert').style.display = 'none'; }, 2000);
    };

    function showAlert(msg, type) {
        const al = $('#statusAlert');
        al.innerText = msg;
        al.className = `alert ${type}`;
        al.style.display = 'block';
    }

    // ==========================================
    // 5. LANCEMENT DE L'EXTRACTION 
    // ==========================================
    setTimeout(() => {
        const now = new Date();
        $('#monthInput').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        try {
            extractedData = runMultiContractBnpExtraction();
            
            if (extractedData && extractedData.totalVal > 0) {
                $('#contractName').innerText = extractedData.contractName;
                $('#totalValue').innerText = fmt(extractedData.totalVal);
                $('#fondEuros').innerText = fmt(extractedData.fondEuros);
                
                const ucCount = extractedData.details.filter(d => d.isin !== 'FONDS-EUROS').length;
                $('#ucTotal').innerText = ucCount > 0 
                  ? `${ucCount} UC (${fmt(extractedData.ucTotal)})`
                  : `Gestion Pilotée (${fmt(extractedData.ucTotal)})`;
                
                if (extractedData.textPreview) {
                  $('#debugBox').value = `[Lignes détectées]\n${extractedData.textPreview}`;
                }
                
                $('#syncBtn').disabled = false;
            } else {
                $('#contractName').innerText = "Attente des données...";
            }
        } catch (err) {
            console.error("Erreur d'extraction :", err);
        }
    }, 2000); // Délai de 2s pour laisser la page de la banque charger

    // ==========================================
    // 6. SYNCHRONISATION API
    // ==========================================
    $('#syncBtn').onclick = () => {
        if (!extractedData || extractedData.totalVal === 0) return;

        const syncBtn = $('#syncBtn');
        syncBtn.disabled = true;
        syncBtn.innerHTML = `<span>⏳</span> Synchronisation...`;
        $('#statusAlert').style.display = 'none';

        const token = GM_getValue('savedToken', '');
        if (!token) {
            showAlert("❌ Jeton manquant : ouvrez PEA Pro ou collez votre jeton.", "error");
            syncBtn.disabled = false;
            syncBtn.innerHTML = `<span>🚀</span> Réessayer`;
            $('#tokenSection').style.display = 'block';
            return;
        }

        const apiUrl = isTestEnv ? URL_TEST : URL_PROD;
        const targetMonth = $('#monthInput').value;

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

        // Utilisation de GM_xmlhttpRequest pour éviter tout blocage CORS depuis le site de la banque
        GM_xmlhttpRequest({
            method: "POST",
            url: apiUrl,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(payload),
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.success) {
                        showAlert(`✅ Relevé de ${targetMonth} synchronisé !`, "success");
                        syncBtn.innerHTML = `<span>✅</span> Synchronisé !`;
                    } else {
                        showAlert(`❌ Erreur API : ${data.error}`, "error");
                        syncBtn.disabled = false;
                        syncBtn.innerHTML = `<span>🚀</span> Réessayer`;
                    }
                } catch(e) {
                    showAlert("❌ Erreur de réponse serveur.", "error");
                    syncBtn.disabled = false;
                    syncBtn.innerHTML = `<span>🚀</span> Réessayer`;
                }
            },
            onerror: function(error) {
                showAlert("❌ Échec réseau.", "error");
                syncBtn.disabled = false;
                syncBtn.innerHTML = `<span>🚀</span> Réessayer`;
            }
        });
    };
})();
