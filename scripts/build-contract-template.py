#!/usr/bin/env python3
"""Build the FFM NDA contract template by patching the retained DOCX in place.

The source document is treated as a package template.  Only the known client
value occurrences are replaced with flat docxtemplater tags; paragraph
properties, run properties, fields, bookmarks, tables, sections, and footer
parts are left in the retained package unless the explicit residue cleanup
requires a package relationship/property removal.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from collections import OrderedDict
from copy import deepcopy
from pathlib import Path
from typing import Iterable

from lxml import etree


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
XML_NS = "http://www.w3.org/XML/1998/namespace"

W = "{" + W_NS + "}"
R = "{" + R_NS + "}"
PKG_REL = "{" + PKG_REL_NS + "}"
CT = "{" + CT_NS + "}"

NS = {"w": W_NS, "r": R_NS}


TAG_ORDER = [
    "discloser_name",
    "discloser_registration",
    "discloser_address",
    "discloser_contact_name",
    "discloser_contact_designation",
    "discloser_contact_address",
    "discloser_contact_email",
    "discloser_signatory_name",
    "discloser_signatory_designation",
    "discloser_witness_name",
    "discloser_witness_designation",
    "recipient_name",
    "recipient_registration",
    "recipient_address",
    "recipient_contact_name",
    "recipient_contact_designation",
    "recipient_contact_address",
    "recipient_contact_email",
    "recipient_signatory_name",
    "recipient_signatory_designation",
    "recipient_witness_name",
    "recipient_witness_designation",
    "purpose",
    "agreement_date",
    "duration_text",
]

EXPECTED_COUNTS = OrderedDict(
    [
        ("discloser_name", 3),
        ("discloser_registration", 3),
        ("discloser_address", 1),
        ("discloser_contact_name", 1),
        ("discloser_contact_designation", 1),
        ("discloser_contact_address", 1),
        ("discloser_contact_email", 1),
        ("discloser_signatory_name", 1),
        ("discloser_signatory_designation", 1),
        ("discloser_witness_name", 1),
        ("discloser_witness_designation", 1),
        ("recipient_name", 3),
        ("recipient_registration", 3),
        ("recipient_address", 1),
        ("recipient_contact_name", 1),
        ("recipient_contact_designation", 1),
        ("recipient_contact_address", 1),
        ("recipient_contact_email", 1),
        ("recipient_signatory_name", 1),
        ("recipient_signatory_designation", 1),
        ("recipient_witness_name", 1),
        ("recipient_witness_designation", 1),
        ("purpose", 2),
        ("agreement_date", 1),
        ("duration_text", 1),
    ]
)

SOURCE_RESIDUE_VALUES = [
    "FFM BERHAD",
    "196201000407",
    "4878-K",
    "PT 45125, Batu 15",
    "HER YI ENGINEERING SDN. BHD.",
    "201101044434",
    "972554-H",
    "2878-1, Jalan PK 18",
    "Liew Kok Wah",
    "Senior Manager, Group Feed Production",
    "2429 Mukim 1, Tingkat Perusahaan Dua Kawasan Perusahaan",
    "KOKWAH.LIEW@ffmb.com.my",
    "heryiengineering@gmail.com",
    "Dr. Liew Kai Wah",
    "Group General Manager",
    "Ho Maw Veng",
    "Director",
    "Ho Choon Kiat",
    "Senior Technical Executive",
    "For on-site visit, review and evaluation of the plant layout",
    "Three (3) years",
    "TEOH, HueyLee (FFMB)",
    "Jackie Cheong Soek Chen",
    "Shook Lin &amp; Bok",
]


class BuildError(RuntimeError):
    pass


def parse_xml(data: bytes) -> etree._Element:
    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False)
    return etree.fromstring(data, parser=parser)


def xml_bytes(root: etree._Element) -> bytes:
    return etree.tostring(root, encoding="UTF-8", xml_declaration=True, standalone=True)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def paragraph_text(p: etree._Element) -> str:
    return "".join(t.text or "" for t in p.xpath(".//w:t", namespaces=NS))


def all_paragraphs(root: etree._Element) -> list[etree._Element]:
    return list(root.xpath(".//w:p", namespaces=NS))


def text_nodes(p: etree._Element) -> list[etree._Element]:
    return list(p.xpath(".//w:t", namespaces=NS))


def set_text(node: etree._Element, value: str) -> None:
    node.text = value
    if value[:1].isspace() or value[-1:].isspace():
        node.set("{%s}space" % XML_NS, "preserve")
    else:
        node.attrib.pop("{%s}space" % XML_NS, None)


def replace_in_paragraph(p: etree._Element, old: str, new: str) -> None:
    """Replace one visible text span while retaining every surrounding run."""

    nodes = text_nodes(p)
    visible = "".join(n.text or "" for n in nodes)
    start = visible.find(old)
    if start < 0:
        raise BuildError(f"Could not find {old!r} in paragraph {visible!r}")
    end = start + len(old)

    first = last = None
    first_offset = last_offset = 0
    pos = 0
    for node in nodes:
        value = node.text or ""
        node_end = pos + len(value)
        if first is None and start < node_end:
            first = node
            first_offset = start - pos
        if end <= node_end:
            last = node
            last_offset = end - pos
            break
        pos = node_end
    if first is None or last is None:
        raise BuildError(f"Could not map replacement span {old!r} in {visible!r}")

    if first is last:
        value = first.text or ""
        set_text(first, value[:first_offset] + new + value[last_offset:])
        return

    first_value = first.text or ""
    last_value = last.text or ""
    set_text(first, first_value[:first_offset] + new)
    for node in nodes[nodes.index(first) + 1 : nodes.index(last)]:
        set_text(node, "")
    set_text(last, last_value[last_offset:])


def replace_paragraph_text(p: etree._Element, new: str) -> None:
    """Replace all visible text in a paragraph without rebuilding its pPr."""

    nodes = text_nodes(p)
    if not nodes:
        r = etree.Element(W + "r")
        p.append(r)
        node = etree.SubElement(r, W + "t")
        set_text(node, new)
        return
    set_text(nodes[0], new)
    for node in nodes[1:]:
        set_text(node, "")


def clear_paragraph_text(p: etree._Element) -> None:
    for node in text_nodes(p):
        set_text(node, "")


def remove_paragraph(p: etree._Element) -> None:
    parent = p.getparent()
    if parent is not None:
        parent.remove(p)


def clean_hyperlink_wrapper(root: etree._Element) -> list[str]:
    removed_ids: list[str] = []
    for hyperlink in list(root.xpath(".//w:hyperlink", namespaces=NS)):
        text = paragraph_text(hyperlink)
        # The retained template contains one sample recipient email link.
        if "heryiengineering@gmail.com" not in text:
            continue
        rid = hyperlink.get(R + "id")
        if rid:
            removed_ids.append(rid)
        parent = hyperlink.getparent()
        if parent is None:
            continue
        insert_at = parent.index(hyperlink)
        for child in list(hyperlink):
            if child.tag == W + "r":
                rpr = child.find(W + "rPr")
                if rpr is not None:
                    for rstyle in rpr.findall(W + "rStyle"):
                        rpr.remove(rstyle)
            parent.insert(insert_at, child)
            insert_at += 1
        parent.remove(hyperlink)
    return removed_ids


def find_one(paragraphs: Iterable[etree._Element], predicate, description: str) -> etree._Element:
    matches = [p for p in paragraphs if predicate(paragraph_text(p))]
    if len(matches) != 1:
        raise BuildError(f"Expected one {description}; found {len(matches)}")
    return matches[0]


def outside_table(p: etree._Element) -> bool:
    return not bool(p.xpath("ancestor::w:tbl", namespaces=NS))


def find_table_by_label(root: etree._Element, label: str) -> tuple[etree._Element, etree._Element, etree._Element]:
    """Return (table, row, description cell) for a schedule/cover label."""

    for table in root.xpath(".//w:tbl", namespaces=NS):
        for row in table.xpath("./w:tr", namespaces=NS):
            cells = row.xpath("./w:tc", namespaces=NS)
            for index, cell in enumerate(cells):
                value = "|".join(paragraph_text(p) for p in cell.xpath("./w:p", namespaces=NS))
                if value.strip() == label and index + 1 < len(cells):
                    return table, row, cells[index + 1]
    raise BuildError(f"Could not locate table row labelled {label!r}")


def find_schedule_row(root: etree._Element, term: str) -> tuple[etree._Element, etree._Element]:
    for table in root.xpath(".//w:tbl", namespaces=NS):
        for row in table.xpath("./w:tr", namespaces=NS):
            cells = row.xpath("./w:tc", namespaces=NS)
            if len(cells) >= 4 and paragraph_text(cells[1].xpath("./w:p[1]", namespaces=NS)[0]).strip() == term:
                return row, cells[3]
    raise BuildError(f"Could not locate schedule row {term!r}")


def find_cell_paragraph(cell: etree._Element, predicate, description: str) -> etree._Element:
    return find_one(cell.xpath("./w:p", namespaces=NS), predicate, description)


def p_index_map(root: etree._Element) -> dict[int, int]:
    return {id(p): i for i, p in enumerate(all_paragraphs(root), 1)}


def locator(root: etree._Element, p: etree._Element, part: str, pmap: dict[int, int]) -> dict:
    return {
        "part": part,
        "paragraph_index": pmap[id(p)],
        "xml_path": root.getroottree().getpath(p),
    }


def record_slot(
    locations: dict[str, list[dict]],
    tag: str,
    root: etree._Element,
    p: etree._Element,
    part: str,
    pmap: dict[int, int],
    note: str | None = None,
) -> None:
    item = locator(root, p, part, pmap)
    if note:
        item["note"] = note
    locations.setdefault(tag, []).append(item)


def apply_body_replacements(root: etree._Element, locations: dict[str, list[dict]]) -> None:
    part = "word/document.xml"
    paragraphs = all_paragraphs(root)
    pmap = p_index_map(root)

    # Cover table: the first two table rows contain the parties and the third
    # row is the cover-purpose slot.
    cover_table = root.xpath(".//w:tbl", namespaces=NS)[0]
    cover_rows = cover_table.xpath("./w:tr", namespaces=NS)
    cover_discloser = cover_rows[0].xpath("./w:tc", namespaces=NS)[1]
    cover_recipient = cover_rows[1].xpath("./w:tc", namespaces=NS)[1]
    cover_purpose = cover_rows[2].xpath("./w:tc", namespaces=NS)[1]

    p = find_cell_paragraph(cover_discloser, lambda t: t.startswith("FFM BERHAD"), "cover discloser name")
    replace_in_paragraph(p, "FFM BERHAD", "{discloser_name}")
    record_slot(locations, "discloser_name", root, p, part, pmap)
    replace_in_paragraph(p, "196201000407 (4878-K)", "{discloser_registration}")
    record_slot(locations, "discloser_registration", root, p, part, pmap)

    p = find_cell_paragraph(cover_recipient, lambda t: t.startswith("HER YI ENGINEERING SDN. BHD."), "cover recipient name")
    replace_in_paragraph(p, "HER YI ENGINEERING SDN. BHD.", "{recipient_name}")
    record_slot(locations, "recipient_name", root, p, part, pmap)
    recipient_reg = find_cell_paragraph(cover_recipient, lambda t: "201101044434 (972554-H)" in t, "cover recipient registration")
    replace_in_paragraph(recipient_reg, "201101044434 (972554-H)", "{recipient_registration}")
    record_slot(locations, "recipient_registration", root, recipient_reg, part, pmap)

    p = cover_purpose.xpath("./w:p[1]", namespaces=NS)[0]
    if not paragraph_text(p).startswith("For on-site visit, review and evaluation"):
        raise BuildError("Unexpected cover purpose text")
    replace_paragraph_text(p, "{purpose}")
    record_slot(locations, "purpose", root, p, part, pmap, "cover purpose")

    # Schedule rows.  Row/column geometry is retained; only text nodes change.
    _, date_cell = find_schedule_row(root, "Date of this Agreement")
    date_paras = date_cell.xpath("./w:p", namespaces=NS)
    if not date_paras or any(paragraph_text(x) for x in date_paras):
        raise BuildError("Schedule agreement-date cell is not blank as expected")
    p = date_paras[0]
    replace_paragraph_text(p, "{agreement_date}")
    record_slot(locations, "agreement_date", root, p, part, pmap)

    _, discloser_cell = find_schedule_row(root, "Discloser")
    p = find_cell_paragraph(discloser_cell, lambda t: t.startswith("Name: FFM BERHAD"), "schedule discloser name")
    replace_in_paragraph(p, "FFM BERHAD", "{discloser_name}")
    record_slot(locations, "discloser_name", root, p, part, pmap)
    p = find_cell_paragraph(discloser_cell, lambda t: "196201000407 (4878-K)" in t, "schedule discloser registration")
    replace_in_paragraph(p, "196201000407 (4878-K)", "{discloser_registration}")
    record_slot(locations, "discloser_registration", root, p, part, pmap)
    p = find_cell_paragraph(discloser_cell, lambda t: t.startswith("Business address:"), "schedule discloser address")
    replace_paragraph_text(p, "Business address: {discloser_address}")
    record_slot(locations, "discloser_address", root, p, part, pmap)

    _, recipient_cell = find_schedule_row(root, "Recipient")
    p = find_cell_paragraph(recipient_cell, lambda t: t.startswith("Name: HER YI ENGINEERING"), "schedule recipient name")
    replace_in_paragraph(p, "HER YI ENGINEERING SDN. BHD.", "{recipient_name}")
    record_slot(locations, "recipient_name", root, p, part, pmap)
    p = find_cell_paragraph(recipient_cell, lambda t: "201101044434 (972554-H)" in t, "schedule recipient registration")
    replace_in_paragraph(p, "201101044434 (972554-H)", "{recipient_registration}")
    record_slot(locations, "recipient_registration", root, p, part, pmap)
    p = find_cell_paragraph(recipient_cell, lambda t: t.startswith("Business address:"), "schedule recipient address")
    replace_paragraph_text(p, "Business address: {recipient_address}")
    record_slot(locations, "recipient_address", root, p, part, pmap)

    _, purpose_cell = find_schedule_row(root, "Purpose")
    p = purpose_cell.xpath("./w:p[1]", namespaces=NS)[0]
    if not paragraph_text(p).startswith("For on-site visit, review and evaluation"):
        raise BuildError("Unexpected schedule purpose text")
    replace_paragraph_text(p, "{purpose}")
    record_slot(locations, "purpose", root, p, part, pmap, "schedule purpose")

    _, duration_cell = find_schedule_row(root, "Duration")
    p = find_cell_paragraph(duration_cell, lambda t: t.startswith("Three (3) years"), "schedule duration")
    replace_in_paragraph(p, "Three (3) years", "{duration_text}")
    record_slot(locations, "duration_text", root, p, part, pmap)

    _, poc_cell = find_schedule_row(root, "Points of Contact")
    p = find_cell_paragraph(poc_cell, lambda t: t.startswith("Name: Liew Kok Wah"), "discloser contact name")
    replace_in_paragraph(p, "Liew Kok Wah", "{discloser_contact_name}")
    record_slot(locations, "discloser_contact_name", root, p, part, pmap)
    p = find_cell_paragraph(poc_cell, lambda t: t.startswith("Designation: Senior Manager"), "discloser contact designation")
    replace_in_paragraph(p, "Senior Manager, Group Feed Production", "{discloser_contact_designation}")
    record_slot(locations, "discloser_contact_designation", root, p, part, pmap)
    p = find_cell_paragraph(poc_cell, lambda t: t.startswith("Address:: 2429 Mukim"), "discloser contact address")
    replace_paragraph_text(p, "Address:: {discloser_contact_address}")
    record_slot(locations, "discloser_contact_address", root, p, part, pmap)
    p = find_cell_paragraph(poc_cell, lambda t: t.startswith("E-Mail: KOKWAH.LIEW@ffmb.com.my"), "discloser contact email")
    replace_in_paragraph(p, "KOKWAH.LIEW@ffmb.com.my", "{discloser_contact_email}")
    record_slot(locations, "discloser_contact_email", root, p, part, pmap)

    p = find_cell_paragraph(poc_cell, lambda t: t.startswith("Name: Ho Maw Veng"), "recipient contact name")
    replace_in_paragraph(p, "Ho Maw Veng", "{recipient_contact_name}")
    record_slot(locations, "recipient_contact_name", root, p, part, pmap)
    p = find_cell_paragraph(poc_cell, lambda t: t.startswith("Designation: Director"), "recipient contact designation")
    replace_in_paragraph(p, "Director", "{recipient_contact_designation}")
    record_slot(locations, "recipient_contact_designation", root, p, part, pmap)
    p = find_cell_paragraph(poc_cell, lambda t: t.startswith("Address: 2878-1, Jalan PK 18"), "recipient contact address")
    replace_paragraph_text(p, "Address: {recipient_contact_address}")
    record_slot(locations, "recipient_contact_address", root, p, part, pmap)
    p = find_cell_paragraph(poc_cell, lambda t: t.startswith("E-Mail: heryiengineering@gmail.com"), "recipient contact email")
    replace_in_paragraph(p, "heryiengineering@gmail.com", "{recipient_contact_email}")
    record_slot(locations, "recipient_contact_email", root, p, part, pmap)

    # Signature blocks.  The registration line for the recipient is split in
    # the source across two paragraphs; preserve the signature-line paragraph
    # and place the complete flat tag in the preceding paragraph.
    p = find_one(paragraphs, lambda t: t.startswith("FFM BERHAD)"), "discloser signature company")
    replace_in_paragraph(p, "FFM BERHAD", "{discloser_name}")
    record_slot(locations, "discloser_name", root, p, part, pmap, "discloser signature")
    p = find_one(paragraphs, lambda t: t.startswith("[Registration No. 196201000407 (4878-K)]"), "discloser signature registration")
    replace_in_paragraph(p, "196201000407 (4878-K)", "{discloser_registration}")
    record_slot(locations, "discloser_registration", root, p, part, pmap, "discloser signature")
    p = find_one(paragraphs, lambda t: t.startswith("  Name: Dr. Liew Kai Wah"), "discloser signatory name")
    replace_in_paragraph(p, "Dr. Liew Kai Wah", "{discloser_signatory_name}")
    record_slot(locations, "discloser_signatory_name", root, p, part, pmap)
    p = find_one(paragraphs, lambda t: t.startswith("  Designation: Group General Manager"), "discloser signatory designation")
    replace_in_paragraph(p, "Group General Manager", "{discloser_signatory_designation}")
    record_slot(locations, "discloser_signatory_designation", root, p, part, pmap)
    p = find_one(paragraphs, lambda t: t.startswith("  Name: Mr. Liew Kok Wah"), "discloser witness name")
    replace_in_paragraph(p, "Mr. Liew Kok Wah", "{discloser_witness_name}")
    record_slot(locations, "discloser_witness_name", root, p, part, pmap)
    signature_paragraphs = [candidate for candidate in paragraphs if outside_table(candidate)]
    p = find_one(signature_paragraphs, lambda t: t.startswith("Designation: Senior Manager, Group Feed"), "discloser witness designation first line")
    replace_paragraph_text(p, "Designation: {discloser_witness_designation}")
    record_slot(locations, "discloser_witness_designation", root, p, part, pmap, "discloser witness signature")
    continuation = find_one(paragraphs, lambda t: t.strip() == "Production", "discloser witness designation continuation")
    remove_paragraph(continuation)

    p = find_one(paragraphs, lambda t: t.startswith("HER YI ENGINEERING SDN. BHD.)"), "recipient signature company")
    replace_in_paragraph(p, "HER YI ENGINEERING SDN. BHD.", "{recipient_name}")
    record_slot(locations, "recipient_name", root, p, part, pmap, "recipient signature")
    p = find_one(paragraphs, lambda t: t.startswith("[Registration No. 201101044434 )"), "recipient signature registration first line")
    replace_paragraph_text(p, "[Registration No. {recipient_registration}]")
    record_slot(locations, "recipient_registration", root, p, part, pmap, "recipient signature; source split across two paragraphs")
    p = find_one(paragraphs, lambda t: "(972554-H)] ) __________________________" in t, "recipient signature registration continuation")
    replace_paragraph_text(p, ") __________________________")
    p = find_one(paragraphs, lambda t: t.startswith("Name: Mr. Ho Maw Veng"), "recipient signatory name")
    replace_in_paragraph(p, "Mr. Ho Maw Veng", "{recipient_signatory_name}")
    record_slot(locations, "recipient_signatory_name", root, p, part, pmap)
    p = find_one(signature_paragraphs, lambda t: t.startswith("Designation: Director"), "recipient signatory designation")
    replace_in_paragraph(p, "Director", "{recipient_signatory_designation}")
    record_slot(locations, "recipient_signatory_designation", root, p, part, pmap)
    p = find_one(paragraphs, lambda t: t.startswith("  Name: Mr. Ho Choon Kiat"), "recipient witness name")
    replace_in_paragraph(p, "Mr. Ho Choon Kiat", "{recipient_witness_name}")
    record_slot(locations, "recipient_witness_name", root, p, part, pmap)
    p = find_one(paragraphs, lambda t: t.startswith("  Designation: Senior Technical Executive"), "recipient witness designation")
    replace_in_paragraph(p, "Senior Technical Executive", "{recipient_witness_designation}")
    record_slot(locations, "recipient_witness_designation", root, p, part, pmap)


def remove_hyperlink_relationships(root: etree._Element, ids: list[str]) -> None:
    for rel in list(root):
        if rel.tag != PKG_REL + "Relationship":
            continue
        if rel.get("Id") in ids:
            root.remove(rel)


def remove_custom_relationships(root: etree._Element) -> None:
    for rel in list(root):
        if rel.tag != PKG_REL + "Relationship":
            continue
        if rel.get("Type", "").endswith("/customXml"):
            root.remove(rel)


def remove_content_type_overrides(root: etree._Element) -> None:
    for override in list(root):
        if override.tag != CT + "Override":
            continue
        part_name = override.get("PartName", "")
        if part_name.startswith("/customXml/") or part_name in {"/docProps/custom.xml", "/docMetadata/LabelInfo.xml"}:
            root.remove(override)


def scrub_metadata(parts: dict[str, bytes]) -> set[str]:
    removed: set[str] = set()
    for name in list(parts):
        if name.startswith("customXml/") or name in {"docProps/custom.xml", "docMetadata/LabelInfo.xml"}:
            del parts[name]
            removed.add(name)

    core = parse_xml(parts["docProps/core.xml"])
    for tag in [
        "{%s}creator" % "http://purl.org/dc/elements/1.1/",
        "{%s}lastModifiedBy" % "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
        "{%s}lastPrinted" % "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    ]:
        for element in core.findall("." + tag):
            parent = element.getparent()
            if parent is not None:
                parent.remove(element)
    parts["docProps/core.xml"] = xml_bytes(core)

    app = parse_xml(parts["docProps/app.xml"])
    app_ns = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
    for element in app.findall("{%s}Company" % app_ns):
        app.remove(element)
    parts["docProps/app.xml"] = xml_bytes(app)
    return removed


def counts_from_parts(parts: dict[str, bytes]) -> OrderedDict[str, int]:
    counts: OrderedDict[str, int] = OrderedDict((tag, 0) for tag in TAG_ORDER)
    tag_re = re.compile(r"\{([A-Za-z0-9_]+)\}")
    for name, data in parts.items():
        if not name.endswith(".xml"):
            continue
        for match in tag_re.finditer(data.decode("utf-8", "replace")):
            if match.group(1) in counts:
                counts[match.group(1)] += 1
    return counts


def visible_source_residue(parts: dict[str, bytes]) -> list[str]:
    text = "\n".join(data.decode("utf-8", "replace") for data in parts.values())
    return [value for value in SOURCE_RESIDUE_VALUES if value in text]


def structural_snapshot(root: etree._Element, parts: dict[str, bytes]) -> dict:
    sects = root.xpath(".//w:sectPr", namespaces=NS)
    fields = root.xpath(".//w:instrText", namespaces=NS)
    bookmarks = root.xpath(".//w:bookmarkStart", namespaces=NS)
    paragraphs = all_paragraphs(root)
    return {
        "sections": len(sects),
        "section_geometry": [
            {
                "pgSz": (dict(s.find(W + "pgSz").attrib) if s.find(W + "pgSz") is not None else {}),
                "pgMar": (dict(s.find(W + "pgMar").attrib) if s.find(W + "pgMar") is not None else {}),
            }
            for s in sects
        ],
        "tables": len(root.xpath(".//w:tbl", namespaces=NS)),
        "footers": [name for name in ("word/footer1.xml", "word/footer2.xml") if name in parts],
        "page_numbering": [
            (dict(s.find(W + "pgNumType").attrib) if s.find(W + "pgNumType") is not None else {})
            for s in sects
        ],
        "empty_paragraphs": sum(1 for p in paragraphs if not paragraph_text(p)),
        "drawing_count": len(root.xpath(".//w:drawing", namespaces=NS)),
        "bookmark_count": len(bookmarks),
        "bookmark_names": sorted(b.get(W + "name", "") for b in bookmarks),
        "instrText_count": len(fields),
        "fldChar_count": len(root.xpath(".//w:fldChar", namespaces=NS)),
        "comments": len(root.xpath(".//w:commentRangeStart", namespaces=NS)),
        "hyperlink_wrappers": len(root.xpath(".//w:hyperlink", namespaces=NS)),
    }


def build(source: Path, output: Path, map_path: Path) -> dict:
    source = source.resolve()
    output = output.resolve()
    map_path = map_path.resolve()
    if not source.exists():
        raise BuildError(f"Source DOCX does not exist: {source}")
    if source == output:
        raise BuildError("Output must differ from retained source")

    source_bytes = source.read_bytes()
    source_hash = sha256(source_bytes)
    with zipfile.ZipFile(source, "r") as zin:
        parts = {info.filename: zin.read(info.filename) for info in zin.infolist()}

    if "word/document.xml" not in parts:
        raise BuildError("Retained DOCX has no word/document.xml")

    root = parse_xml(parts["word/document.xml"])
    before_structure = structural_snapshot(root, parts)
    if before_structure["sections"] != 2 or before_structure["tables"] != 2:
        raise BuildError(f"Unexpected retained structure: {before_structure}")

    pmap = p_index_map(root)
    locations: dict[str, list[dict]] = {}
    removed_hyperlink_ids = clean_hyperlink_wrapper(root)
    apply_body_replacements(root, locations)
    parts["word/document.xml"] = xml_bytes(root)

    # Remove the relationship for the unwrapped sample email and every
    # SharePoint/custom-XML metadata relationship from the retained package.
    doc_rels = parse_xml(parts["word/_rels/document.xml.rels"])
    remove_hyperlink_relationships(doc_rels, removed_hyperlink_ids)
    remove_custom_relationships(doc_rels)
    parts["word/_rels/document.xml.rels"] = xml_bytes(doc_rels)

    root_rels = parse_xml(parts["_rels/.rels"])
    remove_custom_relationships(root_rels)
    for rel in list(root_rels):
        if rel.tag == PKG_REL + "Relationship" and rel.get("Type", "").endswith(("/classificationlabels", "/custom-properties")):
            root_rels.remove(rel)
    parts["_rels/.rels"] = xml_bytes(root_rels)

    content_types = parse_xml(parts["[Content_Types].xml"])
    remove_content_type_overrides(content_types)
    parts["[Content_Types].xml"] = xml_bytes(content_types)

    removed_parts = scrub_metadata(parts)

    after_root = parse_xml(parts["word/document.xml"])
    after_structure = structural_snapshot(after_root, parts)
    tag_counts = counts_from_parts(parts)
    residue = visible_source_residue(parts)

    if tag_counts != EXPECTED_COUNTS:
        raise BuildError(f"Tag count mismatch: {tag_counts} != {EXPECTED_COUNTS}")
    if residue:
        raise BuildError(f"Source sample values remain in output package: {residue}")
    if after_structure["sections"] != before_structure["sections"]:
        raise BuildError("Section count changed")
    if after_structure["tables"] != before_structure["tables"]:
        raise BuildError("Table count changed")
    if after_structure["page_numbering"] != before_structure["page_numbering"]:
        raise BuildError("Section page-numbering settings changed")
    if after_structure["empty_paragraphs"] != before_structure["empty_paragraphs"] - 1:
        raise BuildError("Empty-paragraph count changed beyond the agreement-date insertion")
    if after_structure["drawing_count"] != before_structure["drawing_count"]:
        raise BuildError("Drawing count changed")
    if after_structure["bookmark_names"] != before_structure["bookmark_names"]:
        raise BuildError("Bookmark set changed")
    if after_structure["instrText_count"] != before_structure["instrText_count"]:
        raise BuildError("REF/instruction field count changed")
    if after_structure["fldChar_count"] != before_structure["fldChar_count"]:
        raise BuildError("Field-character count changed")
    if after_structure["comments"] != before_structure["comments"]:
        raise BuildError("Comment count changed unexpectedly")
    if after_structure["hyperlink_wrappers"] != 0:
        raise BuildError("Sample hyperlink wrapper remains")

    output.parent.mkdir(parents=True, exist_ok=True)
    map_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zout:
        for name, data in parts.items():
            # A fixed DOS timestamp keeps repeated builds byte-stable while
            # retaining the source package's part order.
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 0
            info.external_attr = 0
            zout.writestr(info, data)

    part_hashes = OrderedDict((name, sha256(data)) for name, data in sorted(parts.items()))
    template_map = OrderedDict(
        [
            ("template", "ffm-nda-v1"),
            ("source", str(source)),
            ("source_sha256", source_hash),
            ("output", str(output)),
            ("tag_syntax", "flat-docxtemplater"),
            ("tags", list(TAG_ORDER)),
            ("tag_counts", tag_counts),
            ("locations", locations),
            ("source_metadata_removed", sorted(removed_parts)),
            ("removed_hyperlink_relationship_ids", removed_hyperlink_ids),
            ("source_structure", before_structure),
            ("output_structure", after_structure),
            (
                "structural_checks",
                {
                    "sections_preserved": before_structure["sections"] == after_structure["sections"] == 2,
                    "tables_preserved": before_structure["tables"] == after_structure["tables"] == 2,
                    "section_geometry_preserved": before_structure["section_geometry"] == after_structure["section_geometry"],
                    "page_numbering_preserved": before_structure["page_numbering"] == after_structure["page_numbering"],
                    "empty_paragraphs_preserved_except_agreement_date_slot": after_structure["empty_paragraphs"] == before_structure["empty_paragraphs"] - 1,
                    "drawings_preserved": before_structure["drawing_count"] == after_structure["drawing_count"],
                    "bookmarks_preserved": before_structure["bookmark_names"] == after_structure["bookmark_names"],
                    "ref_fields_preserved": before_structure["instrText_count"] == after_structure["instrText_count"],
                    "field_characters_preserved": before_structure["fldChar_count"] == after_structure["fldChar_count"],
                    "signature_stamps_and_blank_lines_structure_preserved": before_structure["empty_paragraphs"] == after_structure["empty_paragraphs"] + 1 and before_structure["drawing_count"] == after_structure["drawing_count"],
                    "source_sample_values_remaining": residue,
                },
            ),
            ("output_package_sha256_by_part", part_hashes),
            (
                "remaining_visual_checks",
                [
                    "Parent-owned render with local Gotenberg and inspect every page at 100% zoom.",
                    "Confirm flat tags do not clip or wrap awkwardly in the cover, schedule, and signature blocks.",
                    "Confirm the agreement-date tag appears in Schedule Item 1 and the second section restarts page numbering at 1.",
                    "Confirm signature blank lines and company stamp placement remain visually aligned.",
                    "The retained app.xml page cache reported 10 pages before authoring; final page count remains unverified until render.",
                ],
            ),
        ]
    )
    map_path.write_text(json.dumps(template_map, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return template_map


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--map", required=True, dest="map_path", type=Path)
    args = parser.parse_args(argv)
    try:
        result = build(args.source, args.output, args.map_path)
    except (OSError, zipfile.BadZipFile, etree.XMLSyntaxError, BuildError) as exc:
        print(f"build-contract-template.py: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"output": result["output"], "map": str(args.map_path.resolve()), "tag_counts": result["tag_counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
