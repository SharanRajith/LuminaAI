import requests

print("Testing backend health...")
r = requests.get("http://localhost:8000/health", timeout=5)
print(f"Backend: {r.json()}")

print("\nGenerating presentation data...")
payload = {
    "prompt": "The future of AI and Space Exploration",
    "model_name": "llama3",
    "theme": "ocean",
    "slide_count": 4,
    "audience": "general",
    "tone": "professional"
}

r2 = requests.post("http://localhost:8000/generate/presentation", json=payload, timeout=120)
if r2.status_code == 200:
    data = r2.json()
    print("Generation successful!")
    print(f"Title: {data.get('title')}")
    print(f"Slides generated: {len(data.get('slides', []))}")
    
    # Try adding an image slide explicitly to test the image logic
    data['slides'].append({
        "type": "image",
        "title": "A view of the cosmos",
        "caption": "Generative imagery representing deep space exploration."
    })
    
    print("\nExporting to PPTX...")
    r3 = requests.post("http://localhost:8000/export/pptx", json={"presentation_data": data}, timeout=30)
    if r3.status_code == 200:
        with open("test_export.pptx", "wb") as f:
            f.write(r3.content)
        print("PPTX exported successfully to test_export.pptx!")
        
        # Check size
        import os
        size = os.path.getsize("test_export.pptx")
        print(f"File size: {size} bytes")
    else:
        print(f"Export failed with status: {r3.status_code}")
        print(r3.text)
else:
    print(f"Generation failed with status: {r2.status_code}")
    print(r2.text)
