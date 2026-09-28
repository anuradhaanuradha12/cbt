from fpdf import FPDF

class PDF(FPDF):
    def header(self):
        self.set_font('Arial', 'B', 15)
        self.set_text_color(33, 37, 41)
        self.cell(0, 10, 'CBT Platform - New Features & Updates', 0, 1, 'C')
        self.set_draw_color(0, 123, 255)
        self.line(10, 20, 200, 20)
        self.ln(10)

    def chapter_title(self, title):
        self.set_font('Arial', 'B', 12)
        self.set_fill_color(0, 123, 255)
        self.set_text_color(255, 255, 255)
        self.cell(0, 10, title, 0, 1, 'L', 1)
        self.ln(4)

    def chapter_body(self, body):
        self.set_font('Arial', '', 11)
        self.set_text_color(50, 50, 50)
        self.multi_cell(0, 7, body)
        self.ln()

pdf = PDF()
pdf.add_page()
pdf.set_font('Arial', '', 12)

overview = ("We have successfully upgraded the CBT (Computer-Based Testing) platform with several exciting new features! "
            "These updates make the system faster, more secure, and easier to use for both students and teachers. "
            "Below is a simple breakdown of everything new in the system.")

pdf.chapter_title('1. Overview')
pdf.chapter_body(overview)

students = ("- Modern Interface: A sleek dark mode design for better focus.\n"
            "- Live Exam Timer: A synchronized countdown timer for all exams.\n"
            "- Fair Play System: A strict anti-cheating rule that tracks switching tabs or leaving the screen. Three strikes will auto-submit the exam.\n"
            "- Instant Results: Get final scores, correct answers, and step-by-step explanations immediately after finishing.\n"
            "- Waiting Room: Enter exams 5 minutes early to read instructions safely.")

pdf.chapter_title('2. What\'s New For Students')
pdf.chapter_body(students)

teachers = ("- Easy Exam Creation: Teachers can assemble exams with a click from a bank of over 97,000 questions.\n"
            "- Smart Scheduling: Schedule exams for specific times and student groups.\n"
            "- Automated Reports: Weekly performance reports are automatically sent to parents.\n"
            "- Analytics Dashboard: View average scores, peak engagement, and detailed attempt data through simple charts.\n"
            "- Multi-Tenant Support: Colleges can securely manage their own students and exams without mixing data.")

pdf.chapter_title('3. What\'s New For Teachers & Admins')
pdf.chapter_body(teachers)

ai_gen = ("- AI Question Generator: An intelligent assistant helps create high-quality questions for JEE and NEET.\n"
          "- Review Process: A new multi-step approval workflow ensures all AI-generated questions are reviewed by human experts before being used.")

pdf.chapter_title('4. AI Question Generation')
pdf.chapter_body(ai_gen)

pdf.output('CBT_Platform_Updates.pdf')
