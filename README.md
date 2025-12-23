# BestSecret Stock Monitor 🔍

Bot de surveillance de stock BestSecret avec ajout automatique au panier et notifications Discord.

## Fonctionnalités

- ✅ Interface web mobile-friendly pour gérer les produits
- ✅ Surveillance automatique du stock toutes les 60 secondes
- ✅ Ajout automatique au panier dès qu'une taille surveillée revient en stock
- ✅ Notifications Discord avec deadline de checkout (20 min)
- ✅ Support multi-produits

## Déploiement sur Railway

1. Créez un nouveau projet sur [Railway](https://railway.app)
2. Connectez votre repo GitHub
3. Configurez les **variables d'environnement** dans Railway :

| Variable | Valeur |
|----------|--------|
| `BESTSECRET_TOKEN` | `Bearer eyJhbGciOiJSUzI1NiIs...` (token complet avec "Bearer ") |
| `DISCORD_WEBHOOK` | `https://discord.com/api/webhooks/123456/abcdef...` |

4. Railway détectera automatiquement Node.js et lancera `npm start`

## Variables d'environnement (OBLIGATOIRES)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `BESTSECRET_TOKEN` | Token Bearer JWT complet (avec "Bearer ") | `Bearer eyJhbGci...` |
| `DISCORD_WEBHOOK` | URL complète du webhook Discord | `https://discord.com/api/webhooks/...` |

## Utilisation

1. Ouvrez l'interface web sur votre téléphone
2. Entrez le code produit et le code couleur
3. Cliquez sur "Rechercher le produit"
4. Sélectionnez les tailles à surveiller (celles en rupture)
5. Cliquez sur "Ajouter au monitoring"

Le bot surveillera le stock et ajoutera automatiquement au panier + enverra une notification Discord dès qu'une taille revient en stock.

## ⚠️ Mise à jour du token

Le token JWT expire régulièrement (~2h). Pour le mettre à jour :

1. Via l'interface web : Section "⚙️ Paramètres du token"
2. Collez le token **SANS** le préfixe "Bearer " (juste `eyJhbGci...`)
3. L'app ajoutera automatiquement le préfixe "Bearer "

**OU** mettez à jour la variable `BESTSECRET_TOKEN` dans Railway avec le token complet `Bearer eyJhbGci...`

## Structure

```
├── server.js          # Serveur Express + logique de monitoring
├── public/
│   └── index.html     # Interface web mobile-friendly
├── package.json
└── README.md
```
