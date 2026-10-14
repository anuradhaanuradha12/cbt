// pdf-lib.js - Lightweight PDF generation for OMR results export
// Pure JavaScript implementation - no external dependencies
// Generates proper PDF binary files
/**
 * Simple PDF generator for OMR scan results
 * Creates proper PDF binary with text content
 */
const PDFGenerator = {
    /**
     * Generate a PDF buffer from OMR scan results
     */
    generateOmrResultsPdf(results, examTitle = 'OMR Scan Results', examId = '', options) {
        const pdf = this.createPdf();
        const colors = options?.colors || {
            high: '#28a745',
            medium: '#ffc107',
            low: '#dc3545'
        };
        // ─── Header Section ─────────────────────────────────────────────────────
        // Add logo placeholder (circle with text)
        const logoSize = 40;
        const logoX = 50;
        const logoTop = 680;
        pdf.addCircle(logoX + logoSize / 2, logoTop + logoSize / 2, logoSize / 2, 2, 0.1, 0.2, 0.4);
        pdf.addText('Q', logoX + logoSize / 2, logoTop + logoSize / 2 + 4, 18, 'Helvetica-Bold', 'center');
        // Title
        pdf.addText(examTitle, 110, 700, 16, 'Helvetica-Bold');
        // Add metadata in a styled box
        const metaBoxX = 50;
        const metaBoxY = 670;
        const metaBoxWidth = 500;
        const metaBoxHeight = 45;
        pdf.addRect(metaBoxX, metaBoxY, metaBoxWidth, metaBoxHeight, 0.05, 0.4, 0.2, 0.6);
        pdf.addLine(metaBoxX, metaBoxY, metaBoxX + metaBoxWidth, metaBoxY, 1);
        pdf.addLine(metaBoxX, metaBoxY + metaBoxHeight, metaBoxX + metaBoxWidth, metaBoxY + metaBoxHeight, 1);
        pdf.addText(`Exam ID: ${examId || 'N/A'}`, metaBoxX + 10, metaBoxY + 15, 10, 'Helvetica');
        pdf.addText(`Generated: ${new Date().toLocaleString()}`, metaBoxX + 10, metaBoxY + 30, 10, 'Helvetica');
        pdf.addText(`Total Questions: ${results.length}`, metaBoxX + 280, metaBoxY + 15, 10, 'Helvetica');
        pdf.addText(`Scan Engine: ${typeof getOcrEngineStatus === 'function' ? (getOcrEngineStatus()?.name || 'unknown') : 'unknown'}`, metaBoxX + 280, metaBoxY + 30, 10, 'Helvetica');
        // ─── Results Table ──────────────────────────────────────────────────────
        const tableStartY = 620;
        const rowHeight = 18;
        const colWidths = [80, 60, 80, 80, 100, 100];
        const colHeaders = ['Question', 'Answer', 'Confidence', 'Status', 'Bubble Position', 'Notes'];
        const colColors = [colors.high, colors.medium, colors.low];
        // Draw table header
        pdf.addRect(50, tableStartY - 5, 500, 20, 0.1, 0.2, 0.4, 0.6);
        let xPos = 50;
        for (let i = 0; i < colHeaders.length; i++) {
            pdf.addText(colHeaders[i], xPos + 5, tableStartY + 5, 9, 'Helvetica-Bold');
            xPos += colWidths[i];
        }
        // Draw table rows
        let yPos = tableStartY;
        const pageHeight = 792;
        const marginBottom = 80;
        let rowIndex = 0;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            // Page break if needed
            if (yPos < marginBottom) {
                pdf.addPage();
                yPos = 720;
                // Redraw header on new page
                pdf.addRect(50, yPos - 5, 500, 20, 0.1, 0.2, 0.4, 0.6);
                xPos = 50;
                for (let j = 0; j < colHeaders.length; j++) {
                    pdf.addText(colHeaders[j], xPos + 5, yPos + 5, 9, 'Helvetica-Bold');
                    xPos += colWidths[j];
                }
                yPos += 15;
            }
            // Alternating row colors
            if (rowIndex % 2 === 0) {
                pdf.addRect(50, yPos - rowHeight + 2, 500, rowHeight - 2, 0.03, 0.9, 0.9, 0.95);
            }
            // Question number
            pdf.addText(`Q${r.q}`, 55, yPos - 5, 10, 'Helvetica');
            // Answer
            const answerColor = r.answer ? colors.high : '#6c757d';
            pdf.addText(r.answer || '—', 55 + colWidths[0], yPos - 5, 10, 'Helvetica-Bold');
            // Confidence bar
            const conf = r.confidence != null ? r.confidence : 0;
            const confColor = conf >= 70 ? colors.high : conf >= 40 ? colors.medium : colors.low;
            // Draw confidence bar
            const barX = 55 + colWidths[0] + colWidths[1];
            const barY = yPos - rowHeight + 4;
            const barWidth = 60;
            const barHeight = 8;
            pdf.addRect(barX, barY, barWidth, barHeight, 0.95, 0.9, 0.9, 0.95);
            pdf.addRect(barX, barY, barWidth * (conf / 100), barHeight, 0.8, ...this.hexToRgb(confColor));
            pdf.addText(`${conf}%`, barX + barWidth + 5, barY + 3, 9, 'Helvetica');
            // Status
            let statusText = 'Review';
            if (conf >= 80)
                statusText = '✓ High';
            else if (conf >= 50)
                statusText = '⚠ Medium';
            else
                statusText = '✗ Low';
            pdf.addText(statusText, barX + barWidth + 5 + 60, yPos - 5, 10, 'Helvetica');
            // Bubble position info (from OCR or detection)
            pdf.addText(`Bubble: ${r.answer || '—'}`, 55 + colWidths[0] + colWidths[1] + colWidths[2], yPos - 5, 9, 'Helvetica');
            // Notes
            let notes = '';
            if (conf < 50)
                notes = 'Low confidence - verify manually';
            else if (conf < 70)
                notes = 'Medium confidence - review recommended';
            pdf.addText(notes, 55 + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3], yPos - 5, 9, 'Helvetica-Oblique');
            yPos -= rowHeight;
            rowIndex++;
        }
        // ─── Summary Section ────────────────────────────────────────────────────
        yPos -= 25;
        pdf.addLine(50, yPos, 540, yPos, 1);
        yPos -= 20;
        pdf.addText('Summary', 50, yPos, 12, 'Helvetica-Bold');
        yPos -= 15;
        const highConf = results.filter(r => (r.confidence || 0) >= 70).length;
        const medConf = results.filter(r => (r.confidence || 0) >= 40 && (r.confidence || 0) < 70).length;
        const lowConf = results.filter(r => (r.confidence || 0) < 40).length;
        // Summary mini-table
        const summaryItems = [
            { label: 'High Confidence', value: highConf, color: colors.high },
            { label: 'Medium Confidence', value: medConf, color: colors.medium },
            { label: 'Low Confidence', value: lowConf, color: colors.low }
        ];
        for (const item of summaryItems) {
            pdf.addCircle(60, yPos - 3, 5, 1, 0, 0, 0);
            pdf.addCircle(60, yPos - 3, 5, 0.3, ...this.hexToRgb(item.color));
            pdf.addText(item.label, 75, yPos - 3, 10, 'Helvetica');
            pdf.addText(`${item.value} questions`, 200, yPos - 3, 10, 'Helvetica-Bold');
            yPos -= 15;
        }
        if (results.length > 0) {
            const avgConf = results.reduce((sum, r) => sum + (r.confidence || 0), 0) / results.length;
            yPos -= 10;
            pdf.addLine(50, yPos, 540, yPos, 0.5);
            yPos -= 15;
            pdf.addText('Average Confidence:', 50, yPos, 11, 'Helvetica');
            // Draw average confidence bar
            pdf.addRect(170, yPos - 5, 200, 10, 0.95, 0.9, 0.9, 0.95);
            pdf.addRect(170, yPos - 5, 200 * (avgConf / 100), 10, 0.8, ...this.hexToRgb(colors.high));
            pdf.addText(`${avgConf.toFixed(1)}%`, 375, yPos - 3, 11, 'Helvetica-Bold');
            yPos -= 20;
        }
        // ─── Footer ─────────────────────────────────────────────────────────────
        yPos -= 30;
        pdf.addLine(50, yPos, 540, yPos, 1);
        yPos -= 15;
        pdf.addText('Scan completed successfully.', 50, yPos, 10, 'Helvetica-Oblique');
        pdf.addText(`Document generated by QForge OMR Scanner`, 350, yPos, 10, 'Helvetica');
        if (options?.includeChart) {
            this.generateConfidenceChart(pdf, results, 50, yPos - 80, 200, 60);
        }
        return pdf.build();
    },
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [
            parseInt(result[1], 16),
            parseInt(result[2], 16),
            parseInt(result[3], 16)
        ] : [0, 0, 0];
    },
    generateConfidenceChart(pdf, results, x, y, width, height) {
        // Simple bar chart showing confidence distribution
        const bins = [0, 20, 40, 60, 80, 100];
        const counts = [0, 0, 0, 0, 0];
        for (const r of results) {
            const conf = r.confidence || 0;
            for (let i = 0; i < bins.length - 1; i++) {
                if (conf >= bins[i] && conf < bins[i + 1]) {
                    counts[i]++;
                    break;
                }
            }
        }
        const maxCount = Math.max(...counts, 1);
        const barWidth = width / counts.length - 5;
        for (let i = 0; i < counts.length; i++) {
            const barHeight = (counts[i] / maxCount) * height;
            const barX = x + i * (barWidth + 5);
            const barY = y + height - barHeight;
            pdf.addRect(barX, barY, barWidth, barHeight, 0.8, 0.2, 0.4, 0.6);
            // Label
            pdf.addText(`${bins[i]}-${bins[i + 1]}%`, barX, y + height + 5, 6, 'Helvetica');
            pdf.addText(`${counts[i]}`, barX + barWidth / 2 - 5, barY - 8, 6, 'Helvetica-Bold');
        }
    },
    /**
     * Generate OMR sheet PDF with the actual layout
     */
    generateOmrSheetPdf(meta, filledAnswers = {}) {
        const pdf = this.createPdf();
        // Page dimensions (A4 in points: 595 x 842)
        const pageWidth = 595;
        const pageHeight = 842;
        const margin = 40;
        pdf.addPageSize(pageWidth, pageHeight);
        // Title
        pdf.addText('OMR Answer Sheet', pageWidth / 2, 60, 16, 'Helvetica-Bold', 'center');
        // Header fields
        let yPos = 100;
        const fieldX = margin;
        const fieldWidth = (pageWidth - margin * 2) / 2 - 10;
        const fields = [
            { label: 'Name:', value: '' },
            { label: 'Roll No:', value: '' },
            { label: 'Exam:', value: meta.examTitle || '' },
            { label: 'Date:', value: '' },
        ];
        for (let i = 0; i < 4; i++) {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const fx = fieldX + col * (fieldWidth + 20);
            const fy = yPos + row * 30;
            pdf.addText(fields[i].label, fx, fy, 11, 'Helvetica');
            // Draw underline for fill-in
            pdf.addLine(fx + 50, fy + 4, fx + fieldWidth, fy + 4, 0.5);
        }
        yPos += 80;
        // Draw OMR grid
        const cols = meta.cols || 2;
        const rows = meta.rows || Math.ceil(meta.questionCount / cols);
        const bubblesPerQ = meta.bubblesPerQuestion || 4;
        const bubbleSize = 20; // points
        const colWidth = (pageWidth - margin * 2 - (cols - 1) * 10) / cols;
        const rowHeight = bubbleSize * 2 + 25;
        const gridStartX = margin;
        const gridStartY = yPos;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const qNum = r * cols + c + 1;
                if (qNum > meta.questionCount)
                    break;
                const cellX = gridStartX + c * (colWidth + 10);
                const cellY = gridStartY + r * rowHeight;
                // Question number
                pdf.addText(`Q${qNum}`, cellX, cellY, 10, 'Helvetica-Bold');
                // Marks
                const marks = meta.marks?.find(m => m.q === qNum);
                const markValue = marks?.marks || 4;
                pdf.addText(`${markValue} marks`, cellX + colWidth - 60, cellY, 9, 'Helvetica');
                // Draw bubble row
                const bubbleY = cellY + 15;
                const bubbleSpacing = bubbleSize + 15;
                const totalWidth = bubblesPerQ * bubbleSpacing;
                const startX = cellX + (colWidth - totalWidth) / 2;
                for (let b = 0; b < bubblesPerQ; b++) {
                    const bx = startX + b * bubbleSpacing;
                    // Draw bubble circle
                    pdf.addCircle(bx + bubbleSize / 2, bubbleY + bubbleSize / 2, bubbleSize / 2 - 1, 0.75);
                    // Label
                    pdf.addText(String.fromCharCode(65 + b), bx + bubbleSize / 2, bubbleY + bubbleSize / 2 + 3, 9, 'Helvetica-Bold');
                    // Fill if answer provided
                    const filled = filledAnswers[`q${qNum}`];
                    if (filled === b) {
                        pdf.addCircle(bx + bubbleSize / 2, bubbleY + bubbleSize / 2, bubbleSize / 2 - 3, 0.3, 0, 0.6, 0);
                    }
                }
                // Row separator
                if (r < rows - 1) {
                    pdf.addLine(cellX, cellY + rowHeight - 5, cellX + colWidth, cellY + rowHeight - 5, 0.3);
                }
            }
        }
        // Footer note
        pdf.addText('Shade exactly one bubble per question. Use blue/black ballpoint pen.', pageWidth / 2, pageHeight - 40, 9, 'Helvetica-Oblique', 'center');
        pdf.addText('Scan with QForge OMR Scanner app', pageWidth / 2, pageHeight - 25, 8, 'Helvetica', 'center');
        return pdf.build();
    },
    /**
     * Create a new PDF document
     */
    createPdf() {
        return new PDFDocument();
    }
};
/**
 * PDF Document class
 */
class PDFDocument {
    constructor() {
        this.pages = [];
        this.currentPage = null;
        this.objects = [];
        this.xref = {};
        this.pageCount = 0;
        this.offset = 0;
    }
    addPageSize(width, height) {
        this.pageWidth = width;
        this.pageHeight = height;
    }
    addPage() {
        this.pageCount++;
        this.pages.push({
            width: this.pageWidth || 595,
            height: this.pageHeight || 842,
            content: [],
            resources: {
                Font: {
                    Helvetica: this.addFontResource('Helvetica'),
                    'Helvetica-Bold': this.addFontResource('Helvetica-Bold'),
                    'Helvetica-Oblique': this.addFontResource('Helvetica-Oblique'),
                }
            }
        });
        this.currentPage = this.pages[this.pages.length - 1];
    }
    addFontResource(name) {
        const objNum = this.objects.length + 1;
        this.objects.push({
            type: 'font',
            name,
            objNum
        });
        return objNum;
    }
    addText(text, x, y, size, font = 'Helvetica', align = 'left') {
        if (!this.currentPage)
            this.addPage();
        const encoded = this.encodeText(text);
        this.currentPage.content.push({
            type: 'text',
            x,
            y,
            size,
            font,
            text: encoded,
            align
        });
    }
    addLine(x1, y1, x2, y2, width = 1) {
        if (!this.currentPage)
            this.addPage();
        this.currentPage.content.push({
            type: 'line',
            x1,
            y1,
            x2,
            y2,
            width
        });
    }
    addRect(x, y, width, height, fillOpacity = 1, r = 0, g = 0, b = 0) {
        if (!this.currentPage)
            this.addPage();
        this.currentPage.content.push({
            type: 'rect',
            x,
            y,
            width,
            height,
            fillOpacity,
            color: { r, g, b }
        });
    }
    addCircle(cx, cy, radius, strokeWidth = 1, fillR = 1, fillG = 1, fillB = 1) {
        if (!this.currentPage)
            this.addPage();
        this.currentPage.content.push({
            type: 'circle',
            cx,
            cy,
            radius,
            strokeWidth,
            fillColor: { r: fillR, g: fillG, b: fillB }
        });
    }
    encodeText(text) {
        // Simple ASCII encoding
        return text.replace(/[\r\n]+/g, ' ');
    }
    build() {
        // Start PDF
        let pdf = '%PDF-1.4\n';
        // Objects will be written here
        const objPositions = [];
        // Write objects
        for (let i = 0; i < this.objects.length; i++) {
            const objNum = this.objects[i].objNum;
            const pos = pdf.length;
            objPositions[objNum] = pos;
            pdf += `${objNum} 0 obj\n`;
            pdf += `<< /Type /Font /Subtype /Type1 /BaseFont /${this.objects[i].name} >>\n`;
            pdf += `endobj\n`;
        }
        // Write pages
        const pagesObjNum = this.objects.length + 1;
        const pagesPos = pdf.length;
        objPositions[pagesObjNum] = pagesPos;
        pdf += `${pagesObjNum} 0 obj\n`;
        pdf += `<< /Type /Pages /Kids [`;
        for (let i = 0; i < this.pages.length; i++) {
            const pageObjNum = this.objects.length + 2 + i;
            pdf += `${pageObjNum} 0 R`;
            if (i < this.pages.length - 1)
                pdf += ' ';
        }
        pdf += `] /Count ${this.pages.length} >>\nendobj\n`;
        // Write page objects
        for (let i = 0; i < this.pages.length; i++) {
            const page = this.pages[i];
            const pageObjNum = this.objects.length + 2 + i;
            const pagePos = pdf.length;
            objPositions[pageObjNum] = pagePos;
            pdf += `${pageObjNum} 0 obj\n`;
            pdf += `<< /Type /Page /Parent ${pagesObjNum} 0 R`;
            pdf += ` /MediaBox [0 0 ${page.width} ${page.height}]`;
            pdf += ` /Resources << /Font <<`;
            for (const [fontName, fontObjNum] of Object.entries(page.resources.Font)) {
                pdf += ` /${fontName} ${fontObjNum} 0 R`;
            }
            pdf += ` >> >>`;
            pdf += ` /Contents ${pageObjNum + 100} 0 R >>\n`;
            pdf += `endobj\n`;
            // Write content stream
            const contentObjNum = pageObjNum + 100;
            const contentPos = pdf.length;
            objPositions[contentObjNum] = contentPos;
            pdf += `${contentObjNum} 0 obj\n`;
            pdf += `<< /Length ${this.getContentStreamLength(page)} >>\n`;
            pdf += `stream\n`;
            pdf += this.generateContentStream(page);
            pdf += `endstream\n`;
            pdf += `endobj\n`;
        }
        // Write catalog
        const catalogObjNum = this.objects.length + 2 + this.pages.length + 100;
        const catalogPos = pdf.length;
        objPositions[catalogObjNum] = catalogPos;
        pdf += `${catalogObjNum} 0 obj\n`;
        pdf += `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>\n`;
        pdf += `endobj\n`;
        // Write xref
        const xrefPos = pdf.length;
        pdf += `xref\n`;
        pdf += `0 ${this.objects.length + 2 + this.pages.length * 2 + 100 + 1}\n`;
        pdf += `0000000000 65535 f \n`;
        for (let i = 0; i < objPositions.length; i++) {
            if (objPositions[i] !== undefined) {
                const offset = objPositions[i].toString().padStart(10, '0');
                pdf += `${offset} 00000 n \n`;
            }
        }
        // Write trailer
        pdf += `trailer\n`;
        pdf += `<< /Size ${this.objects.length + 2 + this.pages.length * 2 + 100 + 1}`;
        pdf += ` /Root ${catalogObjNum} 0 R >>\n`;
        pdf += `startxref\n`;
        pdf += `${xrefPos}\n`;
        pdf += `%%EOF\n`;
        return new TextEncoder().encode(pdf);
    }
    getContentStreamLength(page) {
        let length = 0;
        for (const op of page.content) {
            if (op.type === 'text') {
                length += 50;
            }
            else if (op.type === 'line') {
                length += 30;
            }
            else if (op.type === 'rect') {
                length += 40;
            }
            else if (op.type === 'circle') {
                length += 50;
            }
        }
        return length + 100;
    }
    generateContentStream(page) {
        let stream = '';
        for (const op of page.content) {
            if (op.type === 'text') {
                stream += `${this.pdfTextOp(op)}\n`;
            }
            else if (op.type === 'line') {
                stream += `${this.pdfLineOp(op)}\n`;
            }
            else if (op.type === 'rect') {
                stream += `${this.pdfRectOp(op)}\n`;
            }
            else if (op.type === 'circle') {
                stream += `${this.pdfCircleOp(op)}\n`;
            }
        }
        return stream;
    }
    pdfTextOp(op) {
        const fontObj = op.font === 'Helvetica-Bold' ? 1 : op.font === 'Helvetica-Oblique' ? 2 : 0;
        const fontSize = op.size || 10;
        const leading = fontSize + 4;
        return `BT\n/F${fontObj} ${fontSize} Tf\n${op.x} ${op.y} Td\n(${op.text}) Tj\nET`;
    }
    pdfLineOp(op) {
        return `q\n${op.width} w\n${op.x1} ${op.y1} m\n${op.x2} ${op.y2} l\nS\nQ`;
    }
    pdfRectOp(op) {
        const grd = op.fillOpacity < 1
            ? `q\n${op.fillOpacity} RG\n${op.color.r} ${op.color.g} ${op.color.b} rg`
            : '';
        const fill = op.fillOpacity < 1 ? 'f' : '';
        const endq = op.fillOpacity < 1 ? 'Q' : '';
        return `${grd}\n${op.x} ${op.y} ${op.width} ${op.height} re${fill}\n${endq}`;
    }
    pdfCircleOp(op) {
        const steps = 36;
        let path = '';
        for (let i = 0; i <= steps; i++) {
            const angle = (i / steps) * Math.PI * 2;
            const x = op.cx + Math.cos(angle) * op.radius;
            const y = op.cy + Math.sin(angle) * op.radius;
            path += (i === 0 ? 'm' : 'l') + ` ${x} ${y}`;
        }
        const fillR = op.fillColor ? op.fillColor.r : 1;
        const fillG = op.fillColor ? op.fillColor.g : 1;
        const fillB = op.fillColor ? op.fillColor.b : 1;
        return `q\n${op.strokeWidth} w\n0 0 0 RG\n${fillR} ${fillG} ${fillB} rg\n${path} b\nQ`;
    }
}
// Export for use
window.PDFGenerator = PDFGenerator;
