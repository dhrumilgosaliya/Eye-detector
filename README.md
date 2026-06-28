# 👁 Eye Detector

A web app where a user measures, from their own laptop/phone camera, their
**iris diameter, iris (eye) radius, approximate pupil diameter, and the distance
between their two eyes (inter-pupillary distance / IPD)**. Detection happens live
in the browser with a red→green lock box; locked measurements are saved per-user
to a database, viewable in a history page and an admin panel.

## ⚠️ Important note about "the retina"
A normal camera **cannot** measure the retina — the retina is inside the eyeball
and requires medical equipment (OCT / fundus camera). What a webcam *can*
reliably measure is the **visible iris and pupil** and the **distance between the
eyes**. Real-world millimetres are derived from the medically-standard average
**iris diameter of 11.7 mm**, used as the on-screen scale reference. The
"iris radius" reported is the visible eye radius. Pupil diameter is an
*approximate* estimate from image brightness.

## Tech
- **Backend:** Python / Flask + SQLAlchemy (SQLite by default)
- **Frontend:** HTML/CSS + MediaPipe FaceMesh (runs in the browser; iris landmarks)
- **Auth:** signup / login / logout, hashed passwords, sessions
- **Pages:** Measure dashboard, History, My Profile, Admin

## Features
- Create profile (name, DOB, email, password) → auto-login → dashboard
- Live camera measurement with a **red box** when not positioned well and a
  **green box** when steady & at a good distance
- **Lock** button (enabled only when green/steady) freezes the reading
- **Submit & save** stores the locked values in the database
- **History** page lists all your saved records (with delete)
- **My Profile** page to update name / DOB / email / password
- **Admin** panel: see every user and all their measurements
- Seeded accounts + sample data on first run

## Seeded logins (created automatically on first run)
| Role  | Email                    | Password |
|-------|--------------------------|----------|
| Admin | admin@eyedetector.app    | admin123 |
| Demo  | demo@eyedetector.app     | demo123  |

> Change these before going live (see Security below).

## Run locally
```bash
pip install -r requirements.txt
python app.py
```
Open **http://localhost:5000**.

> The camera needs a secure context: `localhost` works, or HTTPS in production.
> Allow camera permission when the browser asks.

## Deploy free on Render
1. Push this folder to a GitHub repo.
2. Go to https://render.com → **New → Blueprint** → connect the repo.
   Render reads `render.yaml` automatically (web service + `gunicorn app:app`).
   - Or **New → Web Service** manually:
     - Build: `pip install -r requirements.txt`
     - Start: `gunicorn app:app`
3. Add an env var **SECRET_KEY** (any long random string). The blueprint
   generates one for you.
4. Deploy. Render gives you an HTTPS URL — camera access works there.

### Database note on Render free tier
The free tier filesystem is **ephemeral**: the SQLite file resets on each
redeploy/restart. For persistent data, add a managed **PostgreSQL** database and
set the `DATABASE_URL` env var — the app already supports it (it auto-rewrites
`postgres://` → `postgresql://`). No code change needed.

## Why not Netlify?
Netlify only serves static sites / serverless functions and can't run a
persistent Python server with a database, so this app is deployed on Render
instead. (The browser-only measurement page could be split out to Netlify later,
but accounts/admin/storage still need a backend host like Render.)

## Security before going live
- Change the seeded admin/demo passwords (or delete the seed block in `app.py`).
- Set a strong `SECRET_KEY` env var.
- Use HTTPS (Render provides it automatically).

## Project layout
```
app.py                 Flask app: models, auth, routes, admin, seed
requirements.txt
render.yaml            Render blueprint
Procfile               gunicorn start command
templates/             base, login, signup, dashboard, profile, history, admin
static/css/style.css
static/js/measure.js   MediaPipe FaceMesh measurement + lock logic
```
