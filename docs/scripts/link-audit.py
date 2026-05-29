import re, glob, os
os.chdir(os.path.join(os.path.dirname(__file__), "..", "content", "docs"))
files = glob.glob("**/*.mdx", recursive=True)
valid = {"/docs"}
for f in files:
    slug = f[:-4].replace(os.sep, "/")
    if slug.endswith("/index"):
        slug = slug[:-6]
    if slug == "index":
        slug = ""
    valid.add("/docs/" + slug if slug else "/docs")
targets = {}
for f in files:
    txt = open(f, encoding="utf-8").read()
    for m in re.finditer(r'(?:href="|\]\()(/docs/[^"\)#\s]*)', txt):
        t = m.group(1).rstrip("/")
        targets.setdefault(t, set()).add(f.replace(os.sep, "/"))
bad = {t: fs for t, fs in targets.items() if t not in valid}
if not bad:
    print("All internal links resolve OK (%d targets)" % len(targets))
else:
    print("BROKEN LINKS:")
    for t in sorted(bad):
        print(" ", t, "<-", sorted(bad[t]))
