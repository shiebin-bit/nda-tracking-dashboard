# Suppliers, projects and document templates

## Supplier identity

A Supplier ID is the company's existing internal code. Enter it as text, including leading zeros. Codes are unique without regard to letter case. They are separate from agreement numbers, company registration numbers and database UUIDs.

Use **Assign existing items** in a supplier profile to search and select existing documents or agreements. The review includes linked document/tracking groups and shows any reassignment from another supplier before committing. Standalone legacy agreements can also be linked through the agreement details drawer. Matching company names do not cause automatic merging. Renewals retain their supplier association. The original 26-column register workbook remains unchanged; supplier codes are not passed into document generation.

Supplier company and contact details are current master data. Selecting a supplier can populate a new draft, but updating the master does not rewrite existing draft values, generated versions or signed copies.

Projects are shared selections and can be created while preparing a document. An EOI belongs to one supplier and one project; the same supplier can have several project EOIs. NDA documents can be linked to the matching project. Supplier Documents brings these files together without moving or replacing their stored versions.

## Readable references and document creation

Existing and new agreements receive stable website references such as `AGR-000001`; documents receive `DOC-000001`. References remain the same when a record is edited, reassigned, recycled or restored. Database UUIDs and the original Excel agreement numbers stay separate. These references are searchable in the website and are not inserted into document content or the original 26-column workbook.

In Documents, use **New document** and choose a published template. The chosen template determines NDA/EOI type and Word/PDF availability before entering supplier and project details.

## EOI and NDA are separate documents

EOI uses the same generate, preview, download, print, signed-copy upload and manual confirmation workflow as NDA. Confirming an EOI does not create an expiry-tracking record. A missing signed EOI produces a warning for the matching NDA, rather than blocking its preparation or confirmation.

The initial EOI retains the supplied clauses and introduces reusable company/project fields and representative signature, name, designation and date positions. Signature authenticity remains a human check. Document uploads are not an electronic signature service.

## Template drafts and published versions

Upload a DOCX or PDF in Templates, choose NDA or EOI, and define the fields. Source uploads are limited to 20 MiB. Edit a draft, save it, generate its preview and review every page before publishing a new version. Saving later changes requires another preview. A publish creates an immutable version; old contract files do not change.

Field keys identify replacements such as `{recipient_name}`. A field can read from a company, person, agreement or project value, or from a document-specific custom value. Field types are text, number and date. Required fields must be completed before generation.

### Word templates

Edit the text of paragraphs and table cells while retaining the package's page, section, table, image and header/footer structure. Complex Word fields and other protected regions are read-only. Review the import report before using a template. This editor does not provide arbitrary Word page layout, table restructuring or drag-and-drop image editing.

DOCX templates generate both Word and PDF. PDF conversion requires the internal Gotenberg service. Formatting within an edited paragraph may need review, particularly where the original paragraph contains mixed character styling. Unedited regions retain their source formatting.

### PDF templates

The uploaded page remains fixed. Define the page and rectangle for each field, with its font size and alignment; the same field can appear more than once. Text must fit the selected area. Invalid coordinates and overflowing content stop generation rather than silently clipping text.

PDF templates produce PDF files only, so there is no Word download for those generated versions. PDF-only versions still support preview, printing, signed-copy upload, manual confirmation and batch ZIP downloads. Scanned pages remain page backgrounds; OCR and editable PDF body text are not included.

## Multiple CC recipients

Settings supports up to ten CC email addresses. Add each address individually; duplicates and the main To address are removed. The daily digest is sent to the main recipient and all saved CC addresses. Recipients can see the CC list.

Test emails omit CC. Delivery records preserve the recipients used for that submission, so changing preferences does not rewrite old delivery history. Old settings and backups containing a single `ccEmail` are accepted.

## Recovery

Complete PostgreSQL backups include supplier/project masters, template drafts and published versions, EOI/NDA documents, binary files and delivery records. Register JSON recovery continues to affect the NDA register, history and reminder preferences only. It does not recreate missing supplier/project masters or restore templates and document files; missing associations are shown for review.

The FFM brand image is local website artwork used by navigation and the favicon. It is not added to NDA or EOI files.
