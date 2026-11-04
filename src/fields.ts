export const groups = [
  { title: 'Agreement & follow-up', fields: ['Purpose','Date of Agreement','Duration','UOM','PIC','Department','Status'] },
  { title: 'Discloser company', fields: ['Discloser','Discloser Reg No','Discloser Address'] },
  { title: 'Recipient company', fields: ['Recipient','Recipient Reg No','Recipient Address'] },
  { title: 'Discloser people', fields: ['Name of Discloser','Designation of Discloser','Presence of Discloser Name','Presence of Discloser Designation','Email Discloser'] },
  { title: 'Recipient people', fields: ['Name of Recipient','Designation of Recipient','Email Recipient','Presence of Recipient Name','Presence of Recipient Designation3'] },
];
export const labels: Record<string,string> = {
  'Discloser Reg No': 'Registration number', 'Recipient Reg No': 'Registration number',
  'Discloser Address': 'Company address', 'Recipient Address': 'Company address',
  'Date of Agreement': 'Agreement date', 'Duration': 'Duration', 'UOM': 'Unit',
  'Name of Discloser': 'Name', 'Designation of Discloser': 'Designation',
  'Presence of Discloser Name': 'Person present — name', 'Presence of Discloser Designation': 'Person present — designation',
  'Email Discloser': 'Discloser email', 'Name of Recipient': 'Name', 'Designation of Recipient': 'Designation',
  'Email Recipient': 'Recipient email', 'Presence of Recipient Name': 'Person present — name',
  'Presence of Recipient Designation3': 'Person present — designation', 'Status': 'Follow-up status',
};
export const phaseNames: Record<string,string> = {
  overdue:'Expired',today:'Due today','30':'Within 30 days','45':'31–45 days','60':'46–60 days','90':'61–90 days',valid:'Over 90 days',missing:'Date missing',
};
export const phaseClasses: Record<string,string> = {overdue:'red',today:'red','30':'amber','45':'amber','60':'blue','90':'blue',valid:'green',missing:'gray'};
export const requiredFields = ['Recipient','Date of Agreement','Duration','PIC'];
