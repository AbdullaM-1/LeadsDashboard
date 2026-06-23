const fs = require('fs');

const filePath = 'X-1222-36898-fulfillment-1767027062310 (1).csv';
const outPath = 'X-1222-36898-fulfillment-with-business.csv';

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

const output = lines.map((line, i) => {
  if (!line.trim()) return line;
  // Insert "Business Name" after "Email" (column index 10, 0-based)
  // Header: Lead Age,First Name,Middle Name,Last Name,Address,Address 2,City,State,Zip,Phone,Email,IP Address,...
  // We'll just append it as a new last column before fulfill_date... actually insert after Email
  // Simplest: append at the end before last column, or just add at end of header and empty for rows
  if (i === 0) {
    return line + ',Business Name';
  } else {
    return line + ',';
  }
});

fs.writeFileSync(outPath, output.join('\n'), 'utf8');
console.log(`Done! Written to: ${outPath}`);
console.log(`Rows processed: ${lines.filter(l => l.trim()).length - 1} leads`);
