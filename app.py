"""
Eye Detector - Flask backend
-----------------------------
A web app where users measure (from their device camera) the iris diameter,
pupil diameter and inter-pupillary distance (distance between the two eyes).

NOTE ON THE "RETINA": the retina sits inside the eyeball and cannot be measured
with an ordinary camera. What a webcam can reliably measure is the visible iris
and pupil, plus the distance between the two eyes. Real-world millimetres are
derived from the medically-standard average iris diameter (11.7 mm), which the
browser uses as a scale reference. All detection runs client-side (MediaPipe
FaceMesh); this backend handles accounts, storage and the admin view.
"""
import os
from datetime import datetime
from functools import wraps

from flask import (Flask, render_template, request, redirect, url_for,
                   session, flash, jsonify, abort)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")

# SQLite by default; set DATABASE_URL to use Postgres etc.
db_url = os.environ.get("DATABASE_URL", "sqlite:///eye_detector.db")
if db_url.startswith("postgres://"):  # Render/Heroku style fix
    db_url = db_url.replace("postgres://", "postgresql://", 1)
app.config["SQLALCHEMY_DATABASE_URI"] = db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    dob = db.Column(db.String(20))
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    measurements = db.relationship("Measurement", backref="user",
                                   cascade="all, delete-orphan", lazy=True)

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        return check_password_hash(self.password_hash, pw)


class Measurement(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    # millimetre values
    left_iris_diameter = db.Column(db.Float)
    right_iris_diameter = db.Column(db.Float)
    left_pupil_diameter = db.Column(db.Float)
    right_pupil_diameter = db.Column(db.Float)
    left_eye_radius = db.Column(db.Float)
    right_eye_radius = db.Column(db.Float)
    interpupillary_distance = db.Column(db.Float)
    estimated_distance_cm = db.Column(db.Float)  # camera-to-face distance

    def as_dict(self):
        return {
            "id": self.id,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M"),
            "left_iris_diameter": self.left_iris_diameter,
            "right_iris_diameter": self.right_iris_diameter,
            "left_pupil_diameter": self.left_pupil_diameter,
            "right_pupil_diameter": self.right_pupil_diameter,
            "left_eye_radius": self.left_eye_radius,
            "right_eye_radius": self.right_eye_radius,
            "interpupillary_distance": self.interpupillary_distance,
            "estimated_distance_cm": self.estimated_distance_cm,
        }


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        if not session.get("is_admin"):
            abort(403)
        return f(*args, **kwargs)
    return wrapper


def current_user():
    uid = session.get("user_id")
    return db.session.get(User, uid) if uid else None


@app.context_processor
def inject_user():
    return {"current_user": current_user()}


# --------------------------------------------------------------------------- #
# Routes - auth
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    if "user_id" in session:
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        dob = request.form.get("dob", "").strip()
        password = request.form.get("password", "")

        if not (name and email and password):
            flash("Name, email and password are required.", "error")
            return render_template("signup.html")
        if User.query.filter_by(email=email).first():
            flash("An account with that email already exists.", "error")
            return render_template("signup.html")

        user = User(name=name, email=email, dob=dob)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        session["user_id"] = user.id
        session["is_admin"] = user.is_admin
        flash("Profile created. Welcome!", "success")
        return redirect(url_for("dashboard"))
    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        user = User.query.filter_by(email=email).first()
        if user and user.check_password(password):
            session["user_id"] = user.id
            session["is_admin"] = user.is_admin
            return redirect(url_for("dashboard"))
        flash("Invalid email or password.", "error")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    flash("You have been signed out.", "success")
    return redirect(url_for("login"))


# --------------------------------------------------------------------------- #
# Routes - app
# --------------------------------------------------------------------------- #
@app.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/measurements", methods=["POST"])
@login_required
def save_measurement():
    data = request.get_json(silent=True) or {}
    m = Measurement(
        user_id=session["user_id"],
        left_iris_diameter=data.get("left_iris_diameter"),
        right_iris_diameter=data.get("right_iris_diameter"),
        left_pupil_diameter=data.get("left_pupil_diameter"),
        right_pupil_diameter=data.get("right_pupil_diameter"),
        left_eye_radius=data.get("left_eye_radius"),
        right_eye_radius=data.get("right_eye_radius"),
        interpupillary_distance=data.get("interpupillary_distance"),
        estimated_distance_cm=data.get("estimated_distance_cm"),
    )
    db.session.add(m)
    db.session.commit()
    return jsonify({"ok": True, "id": m.id})


@app.route("/history")
@login_required
def history():
    records = (Measurement.query
               .filter_by(user_id=session["user_id"])
               .order_by(Measurement.created_at.desc())
               .all())
    return render_template("history.html", records=records)


@app.route("/measurement/<int:mid>/delete", methods=["POST"])
@login_required
def delete_measurement(mid):
    m = db.session.get(Measurement, mid)
    if m and m.user_id == session["user_id"]:
        db.session.delete(m)
        db.session.commit()
        flash("Record deleted.", "success")
    return redirect(url_for("history"))


@app.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    user = current_user()
    if request.method == "POST":
        user.name = request.form.get("name", user.name).strip()
        user.dob = request.form.get("dob", user.dob).strip()
        new_email = request.form.get("email", user.email).strip().lower()
        if new_email != user.email:
            if User.query.filter_by(email=new_email).first():
                flash("That email is already in use.", "error")
                return render_template("profile.html", user=user)
            user.email = new_email
        new_pw = request.form.get("password", "")
        if new_pw:
            user.set_password(new_pw)
        db.session.commit()
        flash("Profile updated.", "success")
        return redirect(url_for("profile"))
    return render_template("profile.html", user=user)


# --------------------------------------------------------------------------- #
# Routes - admin
# --------------------------------------------------------------------------- #
@app.route("/admin")
@admin_required
def admin():
    users = User.query.order_by(User.created_at.desc()).all()
    total_measurements = Measurement.query.count()
    return render_template("admin.html", users=users,
                           total_measurements=total_measurements)


# --------------------------------------------------------------------------- #
# DB init + seed
# --------------------------------------------------------------------------- #
def seed():
    """Create tables and seed an admin + sample data if empty."""
    db.create_all()
    if User.query.first():
        return

    admin_user = User(name="Site Admin", email="admin@eyedetector.app",
                      dob="1990-01-01", is_admin=True)
    admin_user.set_password("admin123")
    db.session.add(admin_user)

    demo = User(name="Demo User", email="demo@eyedetector.app", dob="2000-05-15")
    demo.set_password("demo123")
    db.session.add(demo)
    db.session.commit()

    # a couple of sample measurements for the demo user
    samples = [
        dict(left_iris_diameter=11.7, right_iris_diameter=11.6,
             left_pupil_diameter=3.4, right_pupil_diameter=3.5,
             left_eye_radius=5.85, right_eye_radius=5.8,
             interpupillary_distance=63.2, estimated_distance_cm=42.0),
        dict(left_iris_diameter=11.8, right_iris_diameter=11.7,
             left_pupil_diameter=3.1, right_pupil_diameter=3.2,
             left_eye_radius=5.9, right_eye_radius=5.85,
             interpupillary_distance=63.0, estimated_distance_cm=38.5),
    ]
    for s in samples:
        db.session.add(Measurement(user_id=demo.id, **s))
    db.session.commit()


with app.app_context():
    seed()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5001)), debug=True)
