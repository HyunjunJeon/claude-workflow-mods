# semgrep --test fixture for rules/kisa-python.yaml: "ruleid" lines must match, "ok" lines must not.
import hashlib
import os
import pickle
import random
import secrets
import sqlite3
import ssl
import subprocess
import traceback

import requests
import yaml
from cryptography.hazmat.primitives.asymmetric import rsa
from flask import Flask, redirect, request, send_file
from werkzeug.utils import secure_filename

app = Flask(__name__)
db = sqlite3.connect("app.db")


@app.route("/user")
def user():
    name = request.args.get("name")
    cur = db.cursor()
    # ruleid: kisa-1-1-sql-injection
    cur.execute(f"SELECT * FROM users WHERE name = '{name}'")
    # ruleid: kisa-1-1-sql-injection
    cur.execute("SELECT * FROM users WHERE name = '" + name + "'")
    # ok: kisa-1-1-sql-injection
    cur.execute("SELECT * FROM users WHERE name = ?", (name,))
    return "ok"


@app.route("/calc")
def calc():
    expr = request.args["expr"]
    # ruleid: kisa-1-2-code-injection
    return str(eval(expr))


@app.route("/calc-fixed")
def calc_fixed():
    # ok: kisa-1-2-code-injection
    return str(eval("1 + 1"))


@app.route("/file")
def read_file():
    name = request.args.get("name")
    # ruleid: kisa-1-3-path-traversal
    with open("/srv/files/" + name) as handle:
        body = handle.read()
    # ok: kisa-1-3-path-traversal
    with open(os.path.join("/srv/files", secure_filename(name))) as handle:
        body += handle.read()
    return body


@app.route("/ping")
def ping():
    host = request.args.get("host")
    # ruleid: kisa-1-5-os-command-injection
    os.system("ping -c 1 " + host)
    # ruleid: kisa-1-5-os-command-injection
    subprocess.run(f"ping -c 1 {host}", shell=True)
    # ok: kisa-1-5-os-command-injection
    subprocess.run(["ping", "-c", "1", host])
    return "ok"


@app.route("/go")
def go():
    # ruleid: kisa-1-7-open-redirect
    return redirect(request.args.get("next"))


@app.route("/home")
def home():
    # ok: kisa-1-7-open-redirect
    return redirect("/")


@app.route("/fetch")
def fetch():
    url = request.args.get("url")
    # ruleid: kisa-1-12-ssrf
    return requests.get(url, timeout=5).text


def digests(data: bytes, password: str):
    # ruleid: kisa-2-4-weak-hash
    hashlib.md5(data).hexdigest()
    # ruleid: kisa-2-4-weak-hash
    hashlib.new("sha1", data)
    # ok: kisa-2-4-weak-hash
    hashlib.sha256(data).hexdigest()
    # ok: kisa-2-4-weak-hash
    hashlib.md5(data, usedforsecurity=False).hexdigest()
    # ruleid: kisa-2-14-unsalted-password-hash
    return hashlib.sha256(password.encode()).hexdigest()


# ruleid: kisa-2-6-hardcoded-secret
DB_PASSWORD = "s3cr3t-pass"
# ruleid: kisa-2-6-hardcoded-secret
config = {"api_key": "sk-live-1234567890"}
# ok: kisa-2-6-hardcoded-secret
DB_PASSWORD_FROM_ENV = os.environ["DB_PASSWORD"]
# ok: kisa-2-6-hardcoded-secret
TOKEN_HEADER = ""


def keys():
    # ruleid: kisa-2-7-short-rsa-key
    weak = rsa.generate_private_key(public_exponent=65537, key_size=1024)
    # ok: kisa-2-7-short-rsa-key
    strong = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    return weak, strong


def tokens():
    # ruleid: kisa-2-8-insecure-random
    reset_token = "".join(random.choices("abcdef0123456789", k=32))
    # ruleid: kisa-2-8-insecure-random
    otp = random.randint(100000, 999999)
    # ok: kisa-2-8-insecure-random
    session_token = secrets.token_urlsafe(32)
    # ok: kisa-2-8-insecure-random
    jitter = random.random()
    return reset_token, otp, session_token, jitter


def tls():
    # ruleid: kisa-2-11-tls-verification-disabled
    requests.get("https://internal.example", verify=False)
    context = ssl.create_default_context()
    # ruleid: kisa-2-11-tls-verification-disabled
    context.check_hostname = False
    # ok: kisa-2-11-tls-verification-disabled
    requests.get("https://internal.example", verify="/etc/ssl/internal-ca.pem")


@app.route("/report")
def report():
    try:
        return build_report()
    except Exception as error:
        # ruleid: kisa-4-1-error-detail-exposed
        return {"error": str(error)}, 500


@app.route("/report-safe")
def report_safe():
    try:
        return build_report()
    except Exception:
        app.logger.exception("report failed")
        # ok: kisa-4-1-error-detail-exposed
        return {"error": "internal error"}, 500


def cleanup(path):
    # ruleid: kisa-4-2-swallowed-exception
    try:
        os.remove(path)
    except OSError:
        pass
    # ok: kisa-4-2-swallowed-exception
    try:
        os.remove(path)
    except FileNotFoundError:
        app.logger.info("already removed: %s", path)


def load(blob, text):
    # ruleid: kisa-5-5-unsafe-deserialization
    pickle.loads(blob)
    # ruleid: kisa-5-5-unsafe-deserialization
    yaml.load(text, Loader=yaml.Loader)
    # ok: kisa-5-5-unsafe-deserialization
    yaml.load(text, Loader=yaml.SafeLoader)
    # ok: kisa-5-5-unsafe-deserialization
    yaml.safe_load(text)


def build_report():
    return traceback.format_stack()


if __name__ == "__main__":
    # ruleid: kisa-6-2-debug-code
    app.run(debug=True)
