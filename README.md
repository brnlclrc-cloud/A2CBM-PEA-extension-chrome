# PEA Pro - Extension Chrome (Sync Assurance Vie BNP Paribas)

Extension Chrome privée pour synchroniser en 1 clic les relevés mensuels d'assurance vie BNP Paribas (Multiplacements 2) vers PEA Pro.

## 🚀 Installation

1. Ouvrez `chrome://extensions` dans Google Chrome.
2. Activez le **Mode développeur** (en haut à droite).
3. Cliquez sur **Charger l'extension non empaquetée**.
4. Sélectionnez ce dossier.
5. Épinglez l'icône dans votre barre d'outils.

## 📦 Structure

- `manifest.json` : Configuration Manifest V3
- `popup.html` / `popup.js` : Interface utilisateur et communication API
- `content.js` : Extracteur DOM récursif pour BNP Paribas
- `icon*.png` : Icônes haute définition PEA Pro
