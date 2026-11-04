# Legacy workbook compatibility fixture

`original-excel-rows.json` retains the original 26-column layout and the test cases needed for spreadsheet compatibility: 11 rows, duplicate display numbers, Pending/Resolved states, dates, missing values, and legacy invalid email placeholders.

Company identity, address, business purpose, contact details and PIC attribution in this fixture are anonymized. The filename describes the legacy workbook layout, not a current production export.

Only test files import this fixture. Application startup does not import or seed these records. Add your working records through the UI or the separate migration tool.
