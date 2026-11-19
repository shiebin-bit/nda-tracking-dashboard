import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import PizZip from 'pizzip';
import type {
  ContractValues,
  PdfFieldPlacement,
  TemplateEditorSnapshot,
  TemplateFieldDefinition,
} from '../src/contract-types.js';
import { englishDate, normalizeCustomValues, templateData } from '../src/contract-core.js';
import { isValidIsoDate } from '../src/core.js';
import { badRequest } from './errors.js';

export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_PARTS = 2_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_TYPE = 'application/pdf';

export const TEMPLATE_CONTENT_TYPES = { docx: DOCX_TYPE, pdf: PDF_TYPE } as const;

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function textOfXml(xml: string): string {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => xmlUnescape(match[1])).join('');
}

function replaceRegionText(xml: string, text: string): string {
  let used = false;
  const replaced = xml.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (_all, open, _body, close) => {
    if (used) return `${open}${close}`;
    used = true;
    return `${open}${xmlEscape(text)}${close}`;
  });
  if (used) return replaced;
  const closeRun = replaced.indexOf('</w:r>');
  if (closeRun >= 0) return `${replaced.slice(0, closeRun)}<w:t xml:space="preserve">${xmlEscape(text)}</w:t>${replaced.slice(closeRun)}`;
  const closeParagraph = replaced.indexOf('</w:p>');
  if (closeParagraph >= 0) return `${replaced.slice(0, closeParagraph)}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>${replaced.slice(closeParagraph)}`;
  return replaced;
}

function docxSafety(zip: PizZip): { warnings: string[]; mainXml: string } {
  const parts = Object.values(zip.files).filter((file) => !file.dir);
  if (!parts.length || parts.length > MAX_ZIP_PARTS) throw badRequest('The Word package has an unsafe number of parts.', 'unsafe_template');
  let expanded = 0;
  for (const part of parts) {
    const declared = Number((part as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
    if (!Number.isFinite(declared) || declared < 0) throw badRequest('The Word package has an invalid part size.', 'unsafe_template');
    expanded += declared;
    if (expanded > MAX_UNCOMPRESSED_BYTES) throw badRequest('The expanded Word package is too large.', 'unsafe_template');
    if (/vbaProject|activeX|embeddings|customUI|oleObject/i.test(part.name)) {
      throw badRequest('Word templates cannot contain macros, embedded objects or active content.', 'unsafe_template');
    }
  }
  const relationships = parts.filter((file) => file.name.endsWith('.rels')).map((file) => file.asText()).join('\n');
  if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) {
    throw badRequest('Word templates cannot contain external relationships.', 'unsafe_template');
  }
  const mainXml = zip.file('word/document.xml')?.asText();
  if (!mainXml) throw badRequest('The file is not a valid Word document.', 'invalid_template');
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(mainXml)) throw badRequest('Word templates cannot contain DTD or entity declarations.', 'unsafe_template');
  const parseErrors: string[] = [];
  const parsed = new DOMParser({ errorHandler: (level, message) => { if (level !== 'warning') parseErrors.push(message); } }).parseFromString(mainXml, 'application/xml');
  if (parseErrors.length || parsed.getElementsByTagName('parsererror').length) throw badRequest('The Word document XML is invalid.', 'invalid_template');
  const warnings: string[] = [];
  if (/<w:instrText\b|<w:fldChar\b/.test(mainXml)) warnings.push('Word fields are protected and cannot be edited in the dashboard.');
  if (/<w:trackRevisions\b|<w:ins\b|<w:del\b/.test(mainXml)) warnings.push('Tracked changes were detected; accept or reject them in Word before publishing.');
  return { warnings, mainXml };
}

export function inspectDocxTemplate(content: Buffer): TemplateEditorSnapshot {
  if (!content.length || content.length > MAX_TEMPLATE_BYTES) throw badRequest('Template files must not exceed 20 MiB.', 'template_too_large');
  let zip: PizZip;
  try { zip = new PizZip(content); } catch { throw badRequest('The file is not a valid Word document.', 'invalid_template'); }
  const { warnings, mainXml } = docxSafety(zip);
  const cellRanges = [...mainXml.matchAll(/<w:tc(?=\s|>)[^>]*>(?:(?!<w:tc(?=\s|>))[\s\S])*?<\/w:tc>/g)].map((match) => [match.index!, match.index! + match[0].length]);
  const regions = [...mainXml.matchAll(/<w:p(?=\s|>)[^>]*>(?:(?!<w:p(?=\s|>))[\s\S])*?<\/w:p>/g)].map((match, index) => ({
    id: `r-${index + 1}`,
    kind: cellRanges.some(([start, end]) => match.index! >= start && match.index! < end) ? 'table-cell' as const : 'paragraph' as const,
    text: textOfXml(match[0]),
    readOnly: /<w:instrText\b|<w:fldChar\b|<w:del\b|<w:ins\b|<w:drawing\b|<w:pict\b|<w:bookmark(Start|End)\b|<w:txbxContent\b/.test(match[0]),
  }));
  const fields = [...new Set([...mainXml.matchAll(/\{([a-z][a-z0-9_]{0,63})\}/gi)].map((match) => match[1]))]
    .map((key): TemplateFieldDefinition => ({ key, label: key.replace(/_/g, ' '), type: 'text', required: false, source: key }));
  return { format: 'docx', fields, regions, warnings };
}

export function applyDocxEditor(content: Buffer, snapshot: TemplateEditorSnapshot): Buffer {
  const zip = new PizZip(content);
  const { mainXml } = docxSafety(zip);
  const paragraphs = [...mainXml.matchAll(/<w:p(?=\s|>)[^>]*>(?:(?!<w:p(?=\s|>))[\s\S])*?<\/w:p>/g)];
  const changes = new Map((snapshot.regions ?? []).map((region) => [region.id, region]));
  let output = mainXml;
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const match = paragraphs[index]; const region = changes.get(`r-${index + 1}`);
    if (!region || region.readOnly || region.text === textOfXml(match[0])) continue;
    const replacement = replaceRegionText(match[0], region.text.normalize('NFC'));
    output = `${output.slice(0, match.index!)}${replacement}${output.slice(match.index! + match[0].length)}`;
  }
  zip.file('word/document.xml', output);
  const rendered = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
  if (rendered.length > MAX_TEMPLATE_BYTES) throw badRequest('Edited template exceeds 20 MiB.', 'template_too_large');
  return rendered;
}

export async function inspectPdfTemplate(content: Buffer): Promise<TemplateEditorSnapshot> {
  validatePdfBytes(content);
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(content, { updateMetadata: false }); } catch { throw badRequest('Encrypted or invalid PDFs cannot be used as templates.', 'invalid_template'); }
  assertSafePdfObjects(pdf);
  if (pdf.getPageCount() > MAX_PDF_PAGES) throw badRequest(`PDF templates must not exceed ${MAX_PDF_PAGES} pages.`, 'template_too_large');
  return { format: 'pdf', fields: [], placements: [], pages: pdf.getPages().map((page,index) => {
    const crop=page.getCropBox(); const rotation=((page.getRotation().angle%360)+360)%360;
    return {page:index+1,width:rotation===90||rotation===270?crop.height:crop.width,height:rotation===90||rotation===270?crop.width:crop.height,rotation};
  }), warnings: [] };
}

export function validatePdfBytes(content: Buffer): void {
  if (!content.length || content.length > MAX_TEMPLATE_BYTES) throw badRequest('Template files must not exceed 20 MiB.', 'template_too_large');
  if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw badRequest('The file is not a valid PDF.', 'invalid_template');
  const source = content.toString('latin1');
  if (/\/Encrypt\b|\/JavaScript\b|\/JS\b|\/EmbeddedFiles\b|\/Launch\b/.test(source)) {
    throw badRequest('Encrypted PDFs and PDFs with scripts or embedded files cannot be templates.', 'unsafe_template');
  }
}

function assertSafePdfObjects(pdf: PDFDocument): void {
  const blocked = ['JavaScript','JS','EmbeddedFiles','Launch','OpenAction','AA','RichMedia'];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    const source = String(object);
    if (blocked.some((name) => source.includes(`/${name}`))) throw badRequest('PDFs with scripts, actions, or embedded files cannot be templates.', 'unsafe_template');
  }
  const names = pdf.catalog.get(PDFName.of('Names'));
  if (names && /\/(JavaScript|EmbeddedFiles)\b/.test(String(names))) throw badRequest('PDFs with scripts or embedded files cannot be templates.', 'unsafe_template');
}

export function normalizeFieldSchema(value: unknown): TemplateFieldDefinition[] {
  if (!Array.isArray(value) || value.length > 100) throw badRequest('Template fields must be an array of at most 100 fields.', 'invalid_template_fields');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badRequest(`Template field ${index + 1} is invalid.`, 'invalid_template_fields');
    const raw = entry as Record<string, unknown>;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key) || seen.has(key.toLowerCase())) throw badRequest(`Template field key ${key || index + 1} is invalid or duplicated.`, 'invalid_template_fields');
    const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : null;
    if (/^(supplier_?id|supplier_?code)$/i.test(key) || (source && /^(supplierId|supplierCode|supplier_?id|supplier_?code)$/i.test(source))) {
      throw badRequest('Supplier ID is dashboard-only and cannot be inserted into a document template.', 'forbidden_template_field');
    }
    seen.add(key.toLowerCase());
    const type = raw.type === 'number' || raw.type === 'date' ? raw.type : 'text';
    return { key, label: String(raw.label ?? key).trim().slice(0, 120), type, required: raw.required === true, source };
  });
}

export function normalizePdfPlacements(value: unknown, fields: TemplateFieldDefinition[]): PdfFieldPlacement[] {
  if (!Array.isArray(value) || value.length > 500) throw badRequest('PDF placements must be an array of at most 500 items.', 'invalid_template_fields');
  const keys = new Set(fields.map((field) => field.key));
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badRequest(`PDF placement ${index + 1} is invalid.`, 'invalid_template_fields');
    const raw = entry as Record<string, unknown>; const field = String(raw.field ?? '');
    const n = (key: string) => Number(raw[key]);
    const page = n('page'); const x = n('x'); const y = n('y'); const width = n('width'); const height = n('height'); const fontSize = n('fontSize');
    if (!keys.has(field) || !Number.isSafeInteger(page) || page < 1 || ![x,y,width,height,fontSize].every(Number.isFinite)
      || x < 0 || y < 0 || width <= 0 || height <= 0 || fontSize < 4 || fontSize > 72) throw badRequest(`PDF placement ${index + 1} is invalid.`, 'invalid_template_fields');
    const align = raw.align === 'center' || raw.align === 'right' ? raw.align : 'left';
    const font = raw.font === 'helvetica' || raw.font === 'courier' ? raw.font : 'times';
    return { field, page, x, y, width, height, fontSize, font, align };
  });
}

export function resolveTemplateFields(values: ContractValues, customValues: unknown, fields: TemplateFieldDefinition[]): Record<string, string> {
  const data = templateData(values, normalizeCustomValues(customValues));
  const output: Record<string, string> = {};
  for (const field of fields) {
    let value = String(data[field.source ?? field.key] ?? '');
    if (field.required && !value.trim()) throw badRequest(`${field.label} is required for document generation.`, 'validation_failed');
    if (field.type === 'number' && value && !Number.isFinite(Number(value))) throw badRequest(`${field.label} must be a number.`, 'validation_failed');
    if (field.type === 'date' && value) {
      if (isValidIsoDate(value)) value = englishDate(value);
      else {
        const parsed = /^\d{1,2} [A-Za-z]+ \d{4}$/.test(value) ? new Date(`${value} UTC`) : new Date(NaN);
        if (!Number.isFinite(parsed.getTime()) || englishDate(parsed.toISOString().slice(0,10)) !== value) {
          throw badRequest(`${field.label} must be a valid date.`, 'validation_failed');
        }
      }
    }
    output[field.key] = value;
  }
  return { ...data, ...output };
}

async function embedPdfFont(pdf: PDFDocument, requested: 'times'|'helvetica'|'courier') {
  if(requested==='helvetica') return pdf.embedFont(StandardFonts.Helvetica);
  if(requested==='courier') return pdf.embedFont(StandardFonts.Courier);
  const configured = (process.env.NDA_DOCUMENT_FONT_PATH ?? process.env.NDA_TEMPLATE_FONT_PATH)?.trim();
  if (configured) {
    try {
      const bytes = await readFile(configured);
      const fontkit = (await import('@pdf-lib/fontkit')).default;
      pdf.registerFontkit(fontkit);
      return pdf.embedFont(bytes, { subset: true });
    } catch { /* fall through to built-in Times Roman */ }
  }
  return pdf.embedFont(StandardFonts.TimesRoman);
}

export async function renderPdfTemplate(content: Buffer, snapshot: TemplateEditorSnapshot, values: Record<string, string>): Promise<Buffer> {
  validatePdfBytes(content);
  const pdf = await PDFDocument.load(content, { updateMetadata: false });
  assertSafePdfObjects(pdf);
  const fonts=new Map<string,Awaited<ReturnType<typeof embedPdfFont>>>(); const pages = pdf.getPages();
  for (const placement of snapshot.placements ?? []) {
    const fontName=placement.font??'times'; let font=fonts.get(fontName);
    if(!font){font=await embedPdfFont(pdf,fontName);fonts.set(fontName,font);}
    const page = pages[placement.page - 1];
    if (!page) throw badRequest(`PDF placement refers to missing page ${placement.page}.`, 'invalid_template_fields');
    const crop=page.getCropBox(); const pageWidth=crop.width; const pageHeight=crop.height;
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const visualWidth = angle === 90 || angle === 270 ? pageHeight : pageWidth;
    const visualHeight = angle === 90 || angle === 270 ? pageWidth : pageHeight;
    if (placement.x + placement.width > visualWidth || placement.y + placement.height > visualHeight) throw badRequest(`PDF field ${placement.field} is outside page ${placement.page}.`, 'invalid_template_fields');
    const value = values[placement.field] ?? '';
    const textWidth = font.widthOfTextAtSize(value, placement.fontSize);
    if (textWidth > placement.width || font.heightAtSize(placement.fontSize) > placement.height) throw badRequest(`${placement.field} does not fit its PDF field area.`, 'field_overflow');
    const visualX = placement.align === 'center' ? placement.x + (placement.width - textWidth) / 2
      : placement.align === 'right' ? placement.x + placement.width - textWidth : placement.x;
    const visualY = placement.y + Math.max(0, (placement.height - font.heightAtSize(placement.fontSize)) / 2);
    const local = angle === 90 ? { x: pageWidth - visualY, y: visualX }
      : angle === 180 ? { x: pageWidth - visualX, y: pageHeight - visualY }
        : angle === 270 ? { x: visualY, y: pageHeight - visualX }
          : { x: visualX, y: visualY };
    page.drawText(value, { x:crop.x+local.x, y:crop.y+local.y, size: placement.fontSize, font, maxWidth: placement.width, rotate: degrees(angle) });
  }
  const output = Buffer.from(await pdf.save({ useObjectStreams: false }));
  if (output.length > MAX_TEMPLATE_BYTES) throw badRequest('Generated PDF exceeds 20 MiB.', 'template_too_large');
  return output;
}

export function sourceChecksum(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
