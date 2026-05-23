# Déploiement Hostinger VPS — Freedom Factory

Cette app est lourde : ffmpeg + libass + whisper.cpp + Chromium (Remotion) + génération d'image/vidéo. Compte au moins **8 Go de RAM, 4 vCPU, 80 Go de disque** pour respirer. Less que ça → tu vas swap pendant les renders.

Tout passe par Docker pour ne pas avoir à recompiler ffmpeg-with-libass et whisper.cpp à la main.

## 0 · Prérequis local (avant push)

- [x] `npm run build` passe (déjà vérifié)
- [x] `.env.local` contient les vraies clés (reste local, pas committé)
- [ ] Sur le VPS : un nom de domaine pointé vers son IP

## 1 · Préparer le VPS (Ubuntu 22.04 / Debian 12)

```bash
ssh root@TON_IP

# Docker + Compose
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin nginx certbot python3-certbot-nginx ufw git

# Firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

## 2 · Récupérer le code

```bash
mkdir -p /opt/freedom-factory && cd /opt/freedom-factory
git clone <ton-repo> .
# OU rsync depuis le Mac :
#   rsync -avz --exclude-from=.dockerignore ./ root@TON_IP:/opt/freedom-factory/
```

## 3 · Configurer les secrets

```bash
cp deploy/env.production.example .env.production
nano .env.production   # colle les clés réelles (ANTHROPIC_API_KEY, FAL_KEY, etc.)
chmod 600 .env.production
```

> ⚠️ Les fichiers `config/settings.json` éventuels créés via la page `/settings` sont écrasés par `.env.production`. Si tu veux piloter une clé via l'UI, ne la mets pas dans `.env.production`.

## 4 · Build + démarrage

```bash
cd /opt/freedom-factory
docker compose build           # ~10 min la 1ère fois (whisper.cpp se compile)
docker compose up -d
docker compose logs -f         # vérifie qu'il écoute sur 0.0.0.0:3000
```

Test rapide :

```bash
curl -I http://127.0.0.1:3000/
# HTTP/1.1 200 OK attendu
```

## 5 · Nginx + HTTPS

```bash
# Remplace le domaine dans la conf
sed -i 's/REPLACE_WITH_YOUR_DOMAIN/factory.tondomaine.com/g' \
  deploy/nginx.conf

# Active le site
cp deploy/nginx.conf /etc/nginx/sites-available/freedom-factory.conf
ln -sf /etc/nginx/sites-available/freedom-factory.conf \
       /etc/nginx/sites-enabled/freedom-factory.conf
rm -f /etc/nginx/sites-enabled/default

# Certificat Let's Encrypt
mkdir -p /var/www/certbot
certbot --nginx -d factory.tondomaine.com \
  --non-interactive --agree-tos -m wimac26@gmail.com --redirect

nginx -t && systemctl reload nginx
```

Vérifie : `https://factory.tondomaine.com` doit afficher l'app.

## 6 · Volumes persistants — où vivent les données

Tout ce qui est généré par l'app est dans des **volumes Docker nommés** (survit aux rebuilds) :

| Volume | Contenu | Volumétrie attendue |
|--------|---------|---------------------|
| `generated` | `public/generated/<jobId>/` (images/vidéos pipeline) | gros, croît vite |
| `uploads`   | `public/uploads/` (refs uploadées via l'UI) | moyen |
| `style-refs`| `public/style-refs/<slug>/` (style kits importés) | moyen |
| `sourcing`  | `public/sourcing/` (packs Pexels/Wikimedia) | gros |
| `outputs`   | sorties auxiliaires | petit |
| `audio`, `mp3` | voiceovers / musiques | moyen |

Backup recommandé :

```bash
# Stop l'app pendant le snapshot pour la cohérence
docker compose stop
tar czf /backup/ff-$(date +%F).tgz \
  /var/lib/docker/volumes/freedom-factory_generated/_data \
  /opt/freedom-factory/config \
  /opt/freedom-factory/.env.production
docker compose start
```

Si le disque sature, le coupable n°1 est `generated`. Tu peux purger les vieux jobs :

```bash
docker exec freedom-factory \
  find public/generated -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

## 7 · Redéployer après un push

```bash
cd /opt/freedom-factory
git pull
docker compose build app
docker compose up -d              # rolling restart, les volumes sont conservés
docker compose logs -f --tail=50
```

## 8 · Monitoring rapide

```bash
docker compose ps                 # statut du container
docker stats freedom-factory      # CPU / RAM en direct
docker compose logs --tail=200 app
df -h /var/lib/docker             # disque (volumes)
```

Healthcheck Docker test toutes les 30s `GET /api/videos`. Si KO 3 fois → `unhealthy`, Docker peut redémarrer (avec `restart: unless-stopped` c'est manuel : `docker compose restart`).

## 9 · Gotchas connus

- **Première génération avec Remotion lente (~30s extra)** : Chromium se "réchauffe". Normal.
- **whisper-cli OOM** : large-v3-turbo-q5_0 consomme ~2 Go de RAM. Si le VPS n'en a que 4 Go, désactive l'alignement Whisper depuis la page `/pipeline` (`alignWithWhisper: false`).
- **ffmpeg lent** : pas de GPU sur Hostinger → tout en CPU. Compte 0.5-1× le temps réel pour un encode H.264.
- **Quota fal.ai / GenAIPro** : surveille tes crédits, l'app peut brûler 100$ en une session si tu lances une pipeline 50 scènes.
- **Logs container** : `docker compose logs` garde tout en mémoire. Configure `daemon.json` avec `log-opts: { max-size: "50m", max-file: "5" }` pour éviter une fuite disque.

## 10 · Rollback express

```bash
cd /opt/freedom-factory
git log --oneline -5              # repère le commit qui marchait
git checkout <SHA>
docker compose build app
docker compose up -d
```
