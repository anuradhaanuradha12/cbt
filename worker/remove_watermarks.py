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
        
        alpha_channel = None
        if len(img.shape) == 3 and img.shape[2] == 4:
            b, g, r, alpha_channel = cv2.split(img)
            img = cv2.merge((b, g, r))
            
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # AGGRESSIVE thresholding (60) to actually destroy the dark grey watermark
        mask = gray > 60
        img[mask] = [255, 255, 255]
        
        if alpha_channel is not None:
            b, g, r = cv2.split(img)
            img = cv2.merge((b, g, r, alpha_channel))
        
        success, encoded_image = cv2.imencode('.webp', img)
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

