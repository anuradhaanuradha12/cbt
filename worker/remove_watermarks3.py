import os
import cv2
import numpy as np
from glob import glob

blobs_dir = r"c:\Users\hp\Downloads\cbt-main\cbt-main\worker\.wrangler\state\v3\r2\cbt-media\blobs"
blob_files = glob(os.path.join(blobs_dir, "*"))

processed = 0
errors = 0

for blob_file in blob_files:
    if not os.path.isfile(blob_file):
        continue
    
    try:
        with open(blob_file, 'rb') as f:
            file_bytes = np.frombuffer(f.read(), dtype=np.uint8)
        
        img = cv2.imdecode(file_bytes, cv2.IMREAD_UNCHANGED)
        if img is None: continue
        
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Binary thresholding at 60: 
        # Text (very dark, < 60) becomes black (0)
        # Dark watermarks (> 60), light watermarks, and background become white (255)
        _, binary = cv2.threshold(gray, 60, 255, cv2.THRESH_BINARY)
        
        # Convert back to BGR so we can save it properly
        final_img = cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)
        
        # Save with lossless webp to prevent compression blur!
        success, encoded_image = cv2.imencode('.webp', final_img, [cv2.IMWRITE_WEBP_QUALITY, 100])
        if success:
            with open(blob_file, 'wb') as f:
                f.write(encoded_image)
            
            processed += 1
            if processed % 1000 == 0:
                print(f"Processed {processed}...")
            
    except Exception as e:
        errors += 1
        print(f"Error processing {blob_file}: {e}")

print(f"Finished processing. Processed: {processed}, Errors: {errors}")
