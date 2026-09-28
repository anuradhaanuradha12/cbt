import os
import cv2
import numpy as np
from glob import glob
import sqlite3

db_path = glob(r"c:\Users\hp\Downloads\cbt-main\cbt-main\worker\.wrangler\state\v3\r2\miniflare-R2BucketObject\*.sqlite")[0]
conn = sqlite3.connect(db_path)
c = conn.cursor()
c.execute("SELECT blob_id FROM _mf_objects WHERE key = 'questions/6b7564bc-6c53-4507-b204-561690bb597c/8a65a2e580e66ff5972ccdacba4ee6b44653797f95301782ad820eb1da400357.webp'")
row = c.fetchone()
conn.close()

if not row:
    print("Blob not found")
    exit(1)

blob_id = row[0]
blob_file = os.path.join(r"c:\Users\hp\Downloads\cbt-main\cbt-main\worker\.wrangler\state\v3\r2\cbt-media\blobs", blob_id)

with open(blob_file, 'rb') as f:
    file_bytes = np.frombuffer(f.read(), dtype=np.uint8)

img = cv2.imdecode(file_bytes, cv2.IMREAD_UNCHANGED)
if len(img.shape) == 3 and img.shape[2] == 4:
    b, g, r, alpha_channel = cv2.split(img)
    img = cv2.merge((b, g, r))

gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

print(f"Image shape: {gray.shape}")
print(f"Min value: {np.min(gray)}")
print(f"Max value: {np.max(gray)}")
print(f"Mean value: {np.mean(gray)}")

# Try to save versions with higher thresholds in artifacts directory
artifact_dir = r"C:\Users\hp\.gemini\antigravity-ide\brain\f7469d76-fb11-4928-b787-e1034fbb79f3"
for thresh in [130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230]:
    test = img.copy()
    test[gray > thresh] = [255, 255, 255]
    cv2.imwrite(os.path.join(artifact_dir, f"test_thresh_{thresh}.png"), test)
    
print("Saved higher threshold test images to artifacts.")


