# Bundle index.html + css/js/bridge/notebook into one self-contained html file
# usage: python3 build_single.py [notebook.ipynb] [out.html]
# default: piola_live.ipynb -> ../_extra/wta/piola_live.html, shown in an iframe of wta/derham.ipynb
import json, re, sys
from pathlib import Path

here = Path(__file__).parent
nbfile = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "piola_live.ipynb"
out = Path(sys.argv[2]) if len(sys.argv) > 2 else here.parent / "_extra" / "wta" / (nbfile.stem + ".html")

rd = lambda f: (here / f).read_text()
js_str = lambda obj: json.dumps(obj).replace("</", "<\\/")

html = rd("index.html")
widgets = re.sub(r"^export ", "", rd("widgets.js"), flags=re.M)
nbjs = re.sub(r"^import .*\n", "", rd("nb.js"), flags=re.M)
embed = "window.NB_EMBED = {notebook: %s, bridge: %s};" % (
    js_str(json.loads(nbfile.read_text())), js_str(rd("bridge.py")))

html = html.replace('<link rel="stylesheet" href="style.css">', "<style>\n" + rd("style.css") + "</style>")
html = html.replace('<script type="module" src="nb.js"></script>',
                    "<script>" + embed + "</script>\n<script type=\"module\">\n" + widgets + "\n" + nbjs + "</script>")
out.write_text(html)
print(out, f"{out.stat().st_size/1024:.0f} KB")
