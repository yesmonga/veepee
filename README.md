# Veepee Stock Monitor 🛒

Bot de surveillance de stock Veepee avec notifications Discord instantanées et **prolongement automatique du panier**.

## Fonctionnalités

- ✅ Interface web mobile-friendly pour gérer les produits
- ✅ Surveillance automatique du stock toutes les 60 secondes
- ✅ **Notifications Discord** dès qu'une taille surveillée revient en stock
- ✅ Lien direct vers le produit pour ajouter rapidement au panier
- ✅ Support multi-produits
- ✅ Parsing automatique des URLs Veepee
- ✅ Alerte Discord quand le token expire
- ✅ **Prolongement automatique du panier** toutes les 13 minutes
- ✅ Notifications Discord lors du prolongement du panier

> ⚠️ **Note**: L'ajout automatique au panier n'est pas possible car Veepee utilise des signatures HMAC par requête. Le bot vous notifie instantanément et vous ajoutez manuellement via l'app/site.

## Prolongement du panier

Veepee garde les articles **15 minutes** dans le panier. Le bot peut prolonger automatiquement ce délai :

1. **Démarrer le prolongement** via l'interface web (section "Panier & Prolongement")
2. Le bot vérifie le panier toutes les **13 minutes**
3. Si des articles sont présents, il lance une requête `recover` pour prolonger
4. Une notification Discord est envoyée à chaque prolongement
5. Si le panier est vide, le prolongement s'arrête automatiquement

## Déploiement sur Railway

1. Créer un nouveau projet sur [Railway](https://railway.app)
2. Connecter ce repo GitHub
3. Configurer les variables d'environnement :

```
DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
VEEPEE_AUTH=VPMWS 103912510:signature...
```

## Variables d'environnement

| Variable | Description | Requis |
|----------|-------------|--------|
| `DISCORD_WEBHOOK` | URL du webhook Discord | Oui |
| `VEEPEE_AUTH` | Header Authorization complet | Oui |
| `PORT` | Port du serveur (défaut: 3000) | Non |

## Utilisation

### Format d'URL Veepee

```
https://www.veepee.fr/gr/product/{saleId}/{itemId}
```

Exemple: `https://www.veepee.fr/gr/product/897233/90983689`

### Mettre à jour l'authentification

L'auth Veepee utilise une signature HMAC. Pour l'obtenir :

1. Ouvrir l'app Veepee sur ton téléphone
2. Intercepter une requête avec un proxy (Charles, mitmproxy, etc.)
3. Copier le header `Authorization` complet (format: `VPMWS userId:signature`)
4. Le coller dans l'interface web ou la variable Railway

### Endpoints API

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/api/products` | GET | Liste des produits surveillés |
| `/api/products/fetch` | POST | Récupérer les infos d'un produit |
| `/api/products/add` | POST | Ajouter un produit au monitoring |
| `/api/products/:key` | DELETE | Supprimer un produit |
| `/api/cart` | GET | État du panier |
| `/api/cart/check` | POST | Vérifier le panier (manuel) |
| `/api/cart/recover` | POST | Prolonger le panier (manuel) |
| `/api/cart/recovery/start` | POST | Démarrer le prolongement auto |
| `/api/cart/recovery/stop` | POST | Arrêter le prolongement auto |
| `/api/config/auth` | POST | Mettre à jour l'authentification |
| `/health` | GET | Health check |

## Notes

- Le panier Veepee a une durée de réservation de ~15 minutes
- L'authentification peut expirer - une notification Discord sera envoyée
- Le bot vérifie le stock toutes les 60 secondes par défaut
