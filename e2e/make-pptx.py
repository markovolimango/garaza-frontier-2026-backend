"""Builds a small .pptx for tests from a theme that ships with Microsoft PowerPoint (macOS).

    python3 e2e/make-pptx.py out.pptx [seconds per slide, e.g. 5,8,12]

Each slide gets a title, a line of body text and an automatic advance time (<p:transition advTm>),
so the deck tests both the conversion to PDF and the slide durations. Needs PowerPoint installed:
the feature it tests (PowerPoint converting the deck) does too.
"""
import re
import sys
import zipfile
from xml.sax.saxutils import escape

THEME = "/Applications/Microsoft PowerPoint.app/Contents/Resources/Office Themes/Parcel.thmx"
SLIDES = [("Acme: meeting notes that write themselves", "Every meeting summarised in one minute"),
          ("Traction: 40 paying teams", "Up from 5 in March"),
          ("Pricing: 40 euros per seat", "Annual plans get two months free")]
NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT = "application/vnd.openxmlformats-officedocument.presentationml"


def shape(sid, ph, text):
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{ph} {sid}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
            f'<p:nvPr><p:ph type="{ph}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>'
            f'<a:p><a:r><a:rPr lang="en-US"/><a:t>{escape(text)}</a:t></a:r></a:p></p:txBody></p:sp>')


def slide(title, body, seconds):
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld {NS}><p:cSld><p:spTree>'
            '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
            f'{shape(2, "ctrTitle", title)}{shape(3, "subTitle", body)}</p:spTree></p:cSld>'
            f'<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition advTm="{int(seconds * 1000)}"/></p:sld>')


def main(out, seconds):
    src = zipfile.ZipFile(THEME)
    z = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    for name in src.namelist():
        if not name.startswith("theme/") or name.endswith(".jpeg") or "themeManager" in name or "presentation.xml" in name:
            continue
        z.writestr("ppt/" + name[len("theme/"):], src.read(name))
    pres = src.read("theme/presentation.xml").decode("utf-8")
    ids = "".join(f'<p:sldId id="{256 + i}" r:id="rIdS{i + 1}"/>' for i in range(len(SLIDES)))
    pres = re.sub(r"(</p:sldMasterIdLst>)", r"\1<p:sldIdLst>" + ids + "</p:sldIdLst>", pres, count=1)
    z.writestr("ppt/presentation.xml", pres)
    rels = "".join(f'<Relationship Id="rIdS{i + 1}" Type="{REL}/slide" Target="slides/slide{i + 1}.xml"/>' for i in range(len(SLIDES)))
    z.writestr("ppt/_rels/presentation.xml.rels",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               f'<Relationship Id="rId1" Type="{REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
               f'<Relationship Id="rIdT" Type="{REL}/theme" Target="theme/theme1.xml"/>{rels}</Relationships>')
    for i, (title, body) in enumerate(SLIDES):
        z.writestr(f"ppt/slides/slide{i + 1}.xml", slide(title, body, seconds[i % len(seconds)]))
        z.writestr(f"ppt/slides/_rels/slide{i + 1}.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   f'<Relationship Id="rId1" Type="{REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>')
    layouts = sorted(n for n in z.namelist() if re.match(r"ppt/slideLayouts/slideLayout\d+\.xml$", n))
    overrides = ([f'<Override PartName="/ppt/presentation.xml" ContentType="{CT}.presentation.main+xml"/>',
                  f'<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="{CT}.slideMaster+xml"/>',
                  '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>']
                 + [f'<Override PartName="/{n}" ContentType="{CT}.slideLayout+xml"/>' for n in layouts]
                 + [f'<Override PartName="/ppt/slides/slide{i + 1}.xml" ContentType="{CT}.slide+xml"/>' for i in range(len(SLIDES))])
    z.writestr("[Content_Types].xml",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
               '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
               '<Default Extension="xml" ContentType="application/xml"/>' + "".join(overrides) + "</Types>")
    z.writestr("_rels/.rels",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               f'<Relationship Id="rId1" Type="{REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
    z.close()


if __name__ == "__main__":
    main(sys.argv[1], [float(s) for s in (sys.argv[2] if len(sys.argv) > 2 else "5,8,12").split(",")])
