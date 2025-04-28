import pandas as pd
import fitz  # PyMuPDF
import json
import os

# Specify the path to your Excel file
excel_file = './MauPassLinks - Copy (2).xlsx'
# Load the Excel file without headers
df = pd.read_excel(excel_file, header=None)

# Function to extract text from a PDF file
def extract_text_from_pdf(pdf_path):
    text_content = ""
    try:
        with fitz.open(pdf_path) as pdf:
            for page_num in range(pdf.page_count):
                page = pdf[page_num]
                text_content += page.get_text()
    except Exception as e:
        print(f"Error reading {pdf_path}: {e}")
    return text_content

# List to store each PDF's data as a dictionary
pdf_data_list = []

# Process each row in the Excel file
for index, row in df.iterrows():
    title = row[0]  # Column A
    url = row[1]    # Column B
    pdf_path = row[2]  # Column C
    
    # Check if pdf_path is a valid string and if the file exists
    if isinstance(pdf_path, str) and os.path.exists(pdf_path) and pdf_path.endswith('.pdf'):
        # Extract text content from the PDF
        pdf_text = extract_text_from_pdf(pdf_path)
        
        # Append the structured data to the list
        pdf_data_list.append({
            "Title": title,
            "URL": url,
            "Content": pdf_text
        })
    else:
        print(f"Invalid or missing file path for row {index + 1}: {pdf_path}")

# Save all PDF data to a single JSON file
output_json_path = "all_pdfs.json"
with open(output_json_path, 'w', encoding='utf-8') as json_file:
    json.dump(pdf_data_list, json_file, ensure_ascii=False, indent=4)

print(f"All PDF data saved to {output_json_path}")