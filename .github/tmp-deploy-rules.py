import base64, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

TARGET = "treding-store-2"
RULES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp-firestore.rules")

def log(*a):
    print(*a, flush=True)

rules_text = open(RULES_PATH, encoding="utf-8").read()
sa = json.loads(os.environ["SA_JSON"])
email, key, cfg = sa.get("client_email", ""), sa.get("private_key", ""), sa.get("project_id", "")
log("RULES_BYTES=%d" % len(rules_text.encode()))
log("BOOL_project_is_treding=%s" % (cfg == TARGET))
log("BOOL_email_is_treding=%s" % email.endswith("@%s.iam.gserviceaccount.com" % TARGET))

def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=")

def mint():
    now = int(time.time())
    h = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    c = b64url(json.dumps({"iss": email, "scope": "https://www.googleapis.com/auth/cloud-platform",
                           "aud": "https://oauth2.googleapis.com/token", "exp": now + 3600, "iat": now}).encode())
    si = h + b"." + c
    open("/tmp/sa_key.pem", "w").write(key)
    sig = subprocess.check_output(["openssl", "dgst", "-sha256", "-sign", "/tmp/sa_key.pem"], input=si)
    jwt = (si + b"." + b64url(sig)).decode()
    r = urllib.request.Request("https://oauth2.googleapis.com/token",
        data=urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                     "assertion": jwt}).encode())
    return json.loads(urllib.request.urlopen(r).read())["access_token"]

def call(tok, method, url, payload=None):
    H = {"Authorization": "Bearer " + tok, "Content-Type": "application/json; charset=utf-8"}
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, headers=H, method=method)
    try:
        resp = urllib.request.urlopen(r)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

tok = mint()
log("MINTED length=%d" % len(tok))

st, body = call(tok, "POST", "https://cloudresourcemanager.googleapis.com/v1/projects/%s:getIamPolicy" % TARGET, {})
log("getIamPolicy(POST) -> HTTP %s" % st)
if st >= 400:
    log("body: " + body[:350])
    log("RESULT=NO_IAM_ACCESS")
    sys.exit(0)

policy = json.loads(body)
member = "serviceAccount:" + email
want = "roles/firebase.admin"
log("ALREADY=%s" % any(b.get("role") == want and member in b.get("members", []) for b in policy.get("bindings", [])))
for b in policy.get("bindings", []):
    if b.get("role") == want:
        if member not in b.get("members", []): b["members"].append(member)
        break
else:
    policy.setdefault("bindings", []).append({"role": want, "members": [member]})
st2, body2 = call(tok, "POST", "https://cloudresourcemanager.googleapis.com/v1/projects/%s:setIamPolicy" % TARGET, {"policy": policy})
log("setIamPolicy -> HTTP %s" % st2)
if st2 >= 400:
    log("body: " + body2[:350]); log("RESULT=NO_SET_IAM"); sys.exit(0)
log("GRANTED roles/firebase.admin")
time.sleep(5)
tok2 = mint()
st3, body3 = call(tok2, "POST", "https://firebaserules.googleapis.com/v1/projects/%s/rulesets" % TARGET,
                  {"source": {"files": [{"name": "firestore.rules", "content": rules_text}]}})
log("CREATE ruleset -> HTTP %s" % st3)
if st3 >= 400:
    log("body: " + body3[:600]); log("RESULT=CREATE_FAILED"); sys.exit(0)
rs = json.loads(body3).get("name"); log("RULESET=%s" % rs)
st4, body4 = call(tok2, "PATCH",
    "https://firebaserules.googleapis.com/v1/projects/%s/releases/cloud.firestore?updateMask=rulesetName" % TARGET,
    {"rulesetName": rs})
log("RELEASE -> HTTP %s" % st4)
log("RELEASE body: " + body4[:400])
log("RESULT=%s" % ("DEPLOYED" if st4 < 400 else "RELEASE_FAILED"))
