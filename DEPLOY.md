# Déploiement Hostinger VPS (Dokploy) — Freedom Factory

VPS Hostinger : **168.231.81.106**, 8 Go RAM / 8 vCPU / 400 Go.
Domaine cible : **ytaa.fr** (à configurer plus tard).
Orchestrateur : **Dokploy** (Traefik + Docker intégrés).

L'app génère vidéos/voix off avec ffmpeg + whisper + Remotion : tout passe par Docker pour éviter de recompiler ffmpeg-with-libass et whisper.cpp à la main.

---

## 1 · Préparer Dokploy

1. Ouvre l'admin Dokploy (probablement `http://168.231.81.106:3000` ou ton URL custom).
2. **Settings → Git Providers → GitHub** : connecte ton compte GitHub (OAuth ou Personal Access Token avec scope `repo`). Dokploy a besoin du droit de lire `stebzzz/freedom-factory`.
3. Note la version de Dokploy (Settings → General) — au cas où on tombe sur un bug.

## 2 · Créer le projet

1. **Projects → Create Project** : nom `freedom-factory`.
2. **Create Service → Compose** (PAS "Application" — on a un docker-compose.yml multi-volumes).
3. **Provider** : GitHub.
4. **Repository** : `stebzzz/freedom-factory`, branch `main`.
5. **Compose File Path** : `docker-compose.yml`.
6. **Build Type** : Dockerfile (Dokploy le détecte tout seul depuis le compose).
7. Save.

## 3 · Variables d'environnement

Dans **Environment** (onglet du service), colle (recrée les clés après révocation) :

```env
ANTHROPIC_API_KEY=
FAL_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
GENAIPRO_API_KEY=
GEMINIGEN_API_KEY=
GOOGLE_AI_STUDIO_KEY=
DASHSCOPE_API_KEY=
# Optionnels (laisse vide si pas d'abo)
SILICONFLOW_API_KEY=
MUBERT_API_KEY=
SUNO_API_KEY=
# Recommandé : route les overlays Pexels/Wikimedia
PEXELS_API_KEY=
PIXABAY_API_KEY=
UNSPLASH_API_KEY=
WAVESPEED_API_KEY=
```

> ⚠️ Pas de quotes autour des valeurs, pas d'espaces avant le `=`.

## 4 · Volumes persistants

Dokploy crée automatiquement les volumes nommés du compose file (`generated`, `uploads`, etc.) sous `/etc/dokploy/projects/freedom-factory/files/`. Pas d'action manuelle, mais vérifie dans l'onglet **Volumes** que tu vois bien :

| Volume | Mount | Rôle |
|---|---|---|
| `generated` | `/app/public/generated` | sorties pipeline (gros, croît vite) |
| `uploads` | `/app/public/uploads` | refs uploadées via l'UI |
| `style-refs` | `/app/public/style-refs` | style kits importés |
| `sourcing` | `/app/public/sourcing` | packs Pexels/Wikimedia |
| `outputs` | `/app/outputs` | sorties auxiliaires |
| `audio` | `/app/audio` | voiceovers |
| `mp3` | `/app/mp3` | musiques |
| `config` | `/app/config` | settings.json runtime |

## 5 · Premier build + deploy

1. Onglet **Deployments → Deploy**. Dokploy va :
   - cloner le repo
   - construire l'image (≈ 10-15 min la 1ère fois : whisper.cpp se compile et le modèle large-v3-turbo-q5_0 se télécharge ~800 Mo)
   - démarrer le container
2. Suis les logs en direct dans **Logs**. À surveiller :
   - `[whisper.cpp]` qui compile sans erreur
   - `▲ Next.js 16.2.1` au démarrage
   - `Listening on http://0.0.0.0:3000`

3. Une fois "Running", check rapide depuis le VPS :
   ```bash
   docker exec -it $(docker ps -qf name=freedom-factory) \
     curl -s http://127.0.0.1:3000/api/videos
   # → JSON, même vide, prouve que l'app répond
   ```

## 6 · Domaine + HTTPS (quand ytaa.fr est prêt)

1. Configure le DNS chez ton registrar :
   ```
   A    ytaa.fr           → 168.231.81.106
   A    www.ytaa.fr       → 168.231.81.106
   ```
2. Attends la propagation (`dig ytaa.fr` → doit retourner ton IP).
3. Dans Dokploy → **Domains → Add Domain** :
   - Host: `ytaa.fr`
   - Path: `/`
   - Container Port: `3000`
   - HTTPS: ✅
   - Certificate: **Let's Encrypt**
4. Save → Dokploy/Traefik génère le certif en ~30s.

Vérifie : `https://ytaa.fr` → l'app.

## 7 · Logs, monitoring, redéploiement

- **Logs en direct** : Dokploy → Logs → onglet "Container"
- **Stats CPU/RAM** : Dokploy → Monitoring (si activé)
- **Redéployer après un git push** :
  - soit clic manuel sur **Deploy** dans l'UI
  - soit active **Auto Deploy** (webhook GitHub) dans l'onglet **General**

## 8 · Backup

Tout ce qui compte est dans les volumes Docker. Snapshot la première fois après quelques renders :

```bash
# Sur le VPS, en root via SSH
cd /etc/dokploy/projects/freedom-factory/files
tar czf /backup/ff-$(date +%F).tgz generated uploads style-refs config outputs audio mp3
# ↑ pause le service pendant 5s pour cohérence si tu veux être propre :
#   docker stop freedom-factory_app_1 && tar ... && docker start freedom-factory_app_1
```

Ou installe **Restic / Borg** sur le VPS et automatise vers un bucket S3 / Backblaze.

## 9 · Gotchas

- **Première génération Remotion lente (~30 s extra)** : Chromium se réchauffe, normal.
- **whisper-cli OOM** : le modèle `large-v3-turbo-q5_0` consomme ~2 Go RAM. Avec 8 Go tu es safe, mais si tu lances 2 jobs en parallèle ça pique. Désactive `alignWithWhisper` côté UI si besoin.
- **ffmpeg lent** : pas de GPU sur Hostinger → tout CPU. Compte 0.5-1× temps réel pour H.264. Le 8vCPU aide bien.
- **Quotas API** : surveille tes crédits fal.ai / GenAIPro / Anthropic. Une pipeline 50 scènes peut brûler 50-100 $.
- **public/9665235-...mp4 (75 Mo)** : déjà dans le repo, GitHub a warné mais accepté. Si tu veux le déplacer en LFS plus tard, c'est sans pression.
- **Logs Docker grossissent** : configure `/etc/docker/daemon.json` avec `{"log-opts": {"max-size": "50m", "max-file": "5"}}` puis `systemctl restart docker` pour éviter une fuite disque.

## 10 · Rollback express

Dans Dokploy → **Deployments → History** : clic sur un build antérieur → "Redeploy". Le container redémarre avec l'image de ce build. Les volumes restent intacts.

Manuel via SSH si Dokploy plante :

```bash
ssh root@168.231.81.106
cd /etc/dokploy/projects/freedom-factory/files/freedom-factory
git log --oneline -5
git checkout <SHA_OK>
docker compose build app
docker compose up -d
```

---

## Mode bare-metal (sans Dokploy) — référence

Si un jour tu veux te passer de Dokploy, le repo contient aussi :

- `deploy/nginx.conf` : conf reverse proxy nginx standalone (timeouts longs, body 2 Go, SSE buffering off)
- `deploy/env.production.example` : template `.env.production` à coller à la racine

Dans ce cas :
```bash
ssh root@168.231.81.106
git clone https://github.com/stebzzz/freedom-factory.git /opt/ff && cd /opt/ff
cp deploy/env.production.example .env.production && nano .env.production
# Dans docker-compose.yml : uncomment "ports: 127.0.0.1:3000:3000"
docker compose build && docker compose up -d
# Ensuite nginx + certbot comme dans n'importe quel guide Next.js.
```
