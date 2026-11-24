# Suppliers, projects and document templates

## Supplier identity

A Supplier ID is the company's existing internal code. Enter it as text, including leading zeros. Codes are unique without regard to letter case. They are separate from agreement numbers, company registration numbers and database UUIDs.

Use **Assign existing items** in a supplier profile to search and select existing documents or agreements. The review includes linked document/tracking groups and shows any reassignment from another supplier before committing. Standalone legacy agreements can also be linked through the agreement details drawer. Matching company names do not cause automatic merging. Renewals retain their supplier association. The original 26-column register workbook remains unchanged; supplier codes are not passed into document generation.

Supplier company and contact details are current master data. Selecting a supplier can populate a new draft, but updating the master does not rewrite existing draft values, generated versions or signed copies.

Projects are shared selections and can be created while preparing a document. An EOI belongs to one supplier and one project; the same supplier can have several project EOIs. NDA documents can be linked to the matching project. Supplier Documents brings these files together without moving or replacing their stored versions.

## Readable references and document creation

Existing and new agreements receive stable website references such as `AGR-000001`; documents receive `DOC-000001`. References remain the same when a record is edited, reassigned, recycled or restored. Database UUIDs and the original Excel agreement numbers stay separate. These references are searchable in the website and are not inserted into document content or the original 26-column workbook.

In Documents, use **New document** and choose a published template. Supplier and project selectors search by ID or name, with prefix matches first. Typing alone does not change the saved association; choose an option to apply it. The chosen template determines NDA/EOI type and Word/PDF availability before entering supplier and project details.

## EOI and NDA are separate documents

EOI uses the same generate, preview, download, print, signed-copy upload and manual confirmation workflow as NDA. Confirming an EOI does not create an expiry-tracking record. A missing signed EOI produces a warning for the matching NDA, rather than blocking its preparation or confirmation.

The initial EOI retains the supplied clauses and introduces reusable company/project fields and representative signature, name, designation and date positions. Signature authenticity remains a human check. Document uploads are not an electronic signature service.

## Template drafts and published versions

Upload a DOCX or PDF in Templates, choose NDA or EOI, and define the fields. Source uploads are limited to 20 MiB. Edit a draft, save it, generate its preview and review every page before publishing a new version. Saving later changes requires another preview. A publish creates an immutable version; old contract files do not change.

Field keys identify replacements such as `{recipient_name}`. A field can read from a company, person, agreement or project value, or from a document-specific custom value. Field types are text, number and date. Required fields must be completed before generation.

To publish another version of your current work, edit the working draft, Save draft, Preview, then Publish version with a new label. Use **Published versions → Copy to working draft** only to start again from a selected earlier published version in the same template family. This action does not select the version used for document generation. There is one working draft per family: replacing it requires explicit confirmation and preserves all published versions. The new draft must be previewed before publishing with a unique version label. **View** previews a published version without changing the working draft or authorizing a new publish.

### Choosing a version for generation

In **Documents → New document**, select a template card and choose its **Published version**, then click **Continue with version …**. You can also change **Template version for next generation** in Document setup. Both the latest and earlier published versions are available for the selected template. The choice applies to the next Generate action in that open editor; reopening a document and bulk generation use the latest published version. Existing files and the template working draft are unchanged. Generation freezes the exact selected template bytes and version.

### Quick field mapping

Select text inside an editable Word paragraph or table cell and choose **Set as field**. Reuse an existing field or choose its data source and label. Replace just the selected occurrence or all exact matches in editable regions; protected structures and existing placeholders are excluded. **Undo edit** reverses recent text, field and structure edits in the current editor, up to 20 steps. Opening another draft or copying a published version resets this local undo history.

**Field checks** lists locations, unused definitions and unbound placeholders. Existing `{field_name}` placeholders are detected on import, including placeholders split across Word runs. EOI imports also recognize exact bracket labels such as `[Project Name / Brief Description]`, `[Project Name]`, `[The recipient]`, `[The recipient / You/ The Company]` and `[Supplier Name]`. These map to project/supplier data and default to bold values. Other bracketed text, ordinary names, protected regions and signature lines are retained. Review the import report and preview before publishing. **Bold value** affects only inserted values. The packaged EOI 1.1 defaults supplier and project values to bold; EOI 1.0 and generated files remain unchanged. An application update advances only an untouched default EOI; custom published templates and unpublished changes are retained.

### Word templates

Edit the text of paragraphs and table cells while retaining source formatting. Use **Paragraph above / below** and **Delete paragraph** for eligible body paragraphs. Simple top-level tables provide **Row above / below** and **Delete row**; new rows inherit the source row's formatting and start with blank cells. At least one original row must remain. New text supports the same Set as field workflow.

Deletion asks for confirmation, lists affected fields and removes field definitions whose final occurrence is deleted. Undo restores both text and field definitions. Changes are saved only to the working draft; preview and publish create a separate permanent version. Existing documents and earlier template versions remain unchanged.

Complex Word fields, bookmarks, section boundaries, merged/nested tables and other protected structures cannot be added or deleted through these controls. Disabled controls explain the restriction. Paragraph structure inside table cells, columns, cell merging, arbitrary page layout and drag-and-drop image editing are outside this editor's scope. Review the import report and every preview page.

DOCX templates generate both Word and PDF using the bundled local LibreOffice converter. Text edits preserve surrounding run styles. Very complex changes are rejected with an explanation instead of flattening the paragraph. Review every generated page before publishing.

### PDF templates

The uploaded page remains fixed. Define the page and rectangle for each field, with its font size and alignment; the same field can appear more than once. Text must fit the selected area. Invalid coordinates and overflowing content stop generation rather than silently clipping text.

PDF templates produce PDF files only, so there is no Word download for those generated versions. PDF-only versions still support preview, printing, signed-copy upload, manual confirmation and batch ZIP downloads. Scanned pages remain page backgrounds; OCR and editable PDF body text are not included.

## Download file names

Open **Settings → Document file names** to enable and order Document type, Supplier name, Project name and Generation date. The preview updates immediately. Document reference and generated version are always appended, for example `EOI_Example Supplier_Project Cedar_2026-11-23_DOC-000012_v2.pdf`.

Settings apply to subsequent downloads of both old and new generated versions, including files inside batch ZIPs. Supplier/project names come from the generation snapshot; the date is the generation date in Malaysia, not the download date. Changing a current supplier/project or downloading tomorrow does not change that snapshot. Blank project parts are omitted. Signed uploads retain their original filenames. Full SQLite backups include these preferences; register-only JSON recovery does not change them.

## Multiple CC recipients

Settings supports up to ten CC email addresses. Add each address individually; duplicates and the main To address are removed. The daily digest is sent to the main recipient and all saved CC addresses. Recipients can see the CC list.

Test emails omit CC. Delivery records preserve the recipients used for that submission, so changing preferences does not rewrite old delivery history. Old settings and backups containing a single `ccEmail` are accepted.

## Recovery

Complete SQLite workspace backups include supplier/project masters, template drafts and published versions, EOI/NDA documents, binary files and delivery records. Register JSON recovery continues to affect the NDA register, history and reminder preferences only. It does not recreate missing supplier/project masters or restore templates and document files; missing associations are shown for review.

The FFM brand image is local website artwork used by navigation and the favicon. It is not added to NDA or EOI files.

The bundled EOI 1.1 keeps the original clauses and bolds supplier/project values. Its acknowledgement starts on the next page without an extra empty page. Existing saved working drafts remain unchanged; choose **Copy to working draft** from 1.1 to adopt it.
