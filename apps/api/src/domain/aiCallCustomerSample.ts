// The "Download sample file" for the AI Call Customers import: 5 dummy rows
// with every supported column (served by GET /api/ai-call-customers/sample; a
// copy is checked in as scripts/sample-ai-call-customers.xlsx). The names,
// numbers and emails are made up.

import ExcelJS from "exceljs";

export const SAMPLE_CUSTOMER_ROWS = [
  ["Asha Raman", "female", "98765 43210", "Raman Textiles", "Asked for the new price list", "asha@example.com", "yes"],
  ["Vikram Iyer", "male", "+91 91234 56780", "Iyer Motors", "Demo booked last month — check feedback", "", "no"],
  ["Meena Kumar", "female", "09876501234", "", "Interested in the annual plan", "meena@example.com", "yes"],
  ["Rahul Das", "male", "919812345678", "Das & Sons", "Call back after Diwali", "", ""],
  ["Priya Nair", "", "8765432109", "Nair Clinic", "First call", "priya@example.com", "no"],
];

export const SAMPLE_CUSTOMER_HEADERS = [
  "customer_name",
  "gender",
  "phone",
  "business_name",
  "follow_up_detail",
  "email",
  "whatsapp_opt_in",
];

export async function buildSampleCustomersWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Customers");
  ws.addRow(SAMPLE_CUSTOMER_HEADERS);
  ws.getRow(1).font = { bold: true };
  for (const r of SAMPLE_CUSTOMER_ROWS) ws.addRow(r);
  // Phone as text so Excel keeps the leading 0 / spaces / +.
  ws.getColumn(3).numFmt = "@";
  ws.columns.forEach((c) => (c.width = 24));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
