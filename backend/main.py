import asyncio
import io
import json
import logging
import re
import os
import urllib.parse
from typing import Optional

import requests
from fastapi import FastAPI, File, HTTPException, UploadFile, Request, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from dotenv import load_dotenv

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from supabase import create_client, Client

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("lumina")

# ─────────────────────────── Setup ────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
supabase: Optional[Client] = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("Supabase client initialised.")
    except Exception as e:
        logger.warning("Supabase disabled — invalid credentials: %s", e)

def get_user_or_ip(request: Request) -> str:
    auth_header = request.headers.get("Authorization")
    if supabase and auth_header:
        try:
            token = auth_header.replace("Bearer ", "")
            user = supabase.auth.get_user(token)
            if user and user.user:
                return f"user:{user.user.id}"
        except Exception as e:
            logger.warning("Token verification failed in rate limiter: %s", e)
    return f"ip:{get_remote_address(request)}"

limiter = Limiter(key_func=get_user_or_ip)

app = FastAPI(title="Lumina AI API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

cors_origin = os.environ.get("CORS_ORIGIN", "*")
if cors_origin == "*":
    logger.warning(
        "CORS_ORIGIN is wildcard '*'. "
        "Set the CORS_ORIGIN environment variable to your frontend URL in production."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=[cors_origin],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────── Models ───────────────────────────

_VALID_THEMES       = {"dark", "ocean", "sunset", "emerald", "corporate"}
_VALID_TONES        = {"professional", "casual", "academic", "inspirational", "humorous"}
_VALID_AUDIENCES    = {"general", "executive", "technical", "student", "expert"}
_VALID_LENGTHS      = {"short", "medium", "long"}
_VALID_REPORT_TYPES = {"business", "research", "technical", "academic", "marketing"}


class PresentationRequest(BaseModel):
    prompt: str = Field(..., min_length=5, max_length=5000)
    model_name: Optional[str] = None
    theme: str = Field("dark")
    slide_count: int = Field(10, ge=3, le=50)
    audience: str = Field("general")
    tone: str = Field("professional")

    @field_validator("theme")
    @classmethod
    def validate_theme(cls, v):
        if v not in _VALID_THEMES:
            raise ValueError(f"theme must be one of {sorted(_VALID_THEMES)}")
        return v

    @field_validator("tone")
    @classmethod
    def validate_tone(cls, v):
        if v not in _VALID_TONES:
            raise ValueError(f"tone must be one of {sorted(_VALID_TONES)}")
        return v

    @field_validator("audience")
    @classmethod
    def validate_audience(cls, v):
        if v not in _VALID_AUDIENCES:
            raise ValueError(f"audience must be one of {sorted(_VALID_AUDIENCES)}")
        return v


class ReportRequest(BaseModel):
    prompt: str = Field(..., min_length=5, max_length=5000)
    model_name: Optional[str] = None
    report_type: str = Field("business")
    tone: str = Field("professional")
    length: str = Field("medium")

    @field_validator("report_type")
    @classmethod
    def validate_report_type(cls, v):
        if v not in _VALID_REPORT_TYPES:
            raise ValueError(f"report_type must be one of {sorted(_VALID_REPORT_TYPES)}")
        return v

    @field_validator("tone")
    @classmethod
    def validate_tone(cls, v):
        if v not in _VALID_TONES:
            raise ValueError(f"tone must be one of {sorted(_VALID_TONES)}")
        return v

    @field_validator("length")
    @classmethod
    def validate_length(cls, v):
        if v not in _VALID_LENGTHS:
            raise ValueError(f"length must be one of {sorted(_VALID_LENGTHS)}")
        return v


class ExportRequest(BaseModel):
    presentation_data: dict

# ─────────────────────────── Helpers ──────────────────────────

def extract_json(text: str) -> dict:
    """Extract the first complete JSON object from LLM response text.

    Uses brace-matching instead of a greedy regex so nested objects
    and multiple JSON blocks are handled correctly.
    """
    def clean_obj(obj):
        if isinstance(obj, dict):
            return {k: clean_obj(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [clean_obj(v) for v in obj]
        elif isinstance(obj, str):
            return re.sub(r'<[^>]*>', '', obj)
        return obj

    start = text.find('{')
    if start == -1:
        raise ValueError("No JSON object found in AI response")

    depth = 0
    in_string = False
    escape_next = False

    for i, ch in enumerate(text[start:], start):
        if escape_next:
            escape_next = False
            continue
        if ch == '\\' and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                candidate = text[start:i + 1]
                try:
                    data = json.loads(candidate)
                    return clean_obj(data)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Malformed JSON in AI response: {exc}") from exc

    raise ValueError("No complete JSON object found in AI response")


def smart_truncate(text: str, max_chars: int = 6000) -> str:
    """Truncate text at a paragraph or sentence boundary instead of mid-word."""
    if len(text) <= max_chars:
        return text
    window = text[:max_chars]
    last_para = window.rfind('\n\n')
    if last_para > max_chars * 0.8:
        return window[:last_para].strip()
    for punct in ('. ', '! ', '? '):
        last_sent = window.rfind(punct)
        if last_sent > max_chars * 0.8:
            return window[:last_sent + 1].strip()
    return window.rstrip()


def generate_with_groq(prompt: str, model_name: Optional[str] = None):
    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        raise ValueError("GROQ_API_KEY is not set. Get a free key at https://console.groq.com")
    model = model_name or "llama-3.3-70b-versatile"
    response = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
            "temperature": 0.7,
        },
        timeout=60,
    )
    if response.status_code != 200:
        raise ValueError(f"Groq API error {response.status_code}: {response.text}")
    return response.json()["choices"][0]["message"]["content"]


def verify_token(authorization: Optional[str] = Header(None)) -> Optional[str]:
    """Optional JWT verification. Returns user_id if valid."""
    if not supabase or not authorization:
        return None
    try:
        token = authorization.replace("Bearer ", "")
        user = supabase.auth.get_user(token)
        return user.user.id if user and user.user else None
    except Exception as e:
        logger.warning("Token verification failed: %s", e)
        return None

# ─────────────────────────── Routes ───────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/generate/presentation")
@limiter.limit("3/day")
async def generate_presentation(req: PresentationRequest, request: Request, user_id: Optional[str] = Depends(verify_token)):
    try:
        prompt = f"""You are an expert presentation designer and content strategist.
Create a comprehensive, engaging presentation on the topic below.

REQUIREMENTS:
- Exactly {req.slide_count} slides
- Audience: {req.audience}
- Tone: {req.tone}
- Use a variety of slide types for visual interest

TOPIC: {req.prompt}

Return ONLY valid JSON (no markdown fences) matching this schema exactly.
CRITICAL: Do NOT use HTML tags (like <h1>) or Markdown inside JSON values. Use plain text only!

Each slide must include an "image_position" field. Choose the best layout for that slide's content:
- "full"  — AI image fills the entire slide background (best for title, quote, dramatic moments)
- "right" — image panel on the right, text on the left (good for content-heavy slides)
- "left"  — image panel on the left, text on the right (vary this for visual rhythm)
- "none"  — no image, text-only layout (good for dense data or agenda slides)

{{
  "title": "...",
  "subtitle": "...",
  "theme": "{req.theme}",
  "slides": [
    {{ "type": "title",     "title": "...", "subtitle": "...", "image_position": "full", "notes": "..." }},
    {{ "type": "agenda",    "title": "Agenda", "items": ["...", "..."], "image_position": "none", "notes": "..." }},
    {{ "type": "content",   "title": "...", "bullets": ["...", "..."], "image_position": "right", "notes": "..." }},
    {{ "type": "quote",     "quote": "...", "author": "...", "image_position": "full", "notes": "..." }},
    {{ "type": "stats",     "title": "...", "stats": [{{"value":"...","label":"...","description":"..."}}], "image_position": "full", "notes": "..." }},
    {{ "type": "content",   "title": "...", "bullets": ["...", "..."], "image_position": "left", "notes": "..." }},
    {{ "type": "conclusion","title": "Key Takeaways", "bullets": ["...", "..."], "image_position": "right", "notes": "..." }}
  ]
}}

Make content substantive and insightful. Vary slide types AND image_position throughout for visual rhythm."""

        response_text = generate_with_groq(prompt, req.model_name)
        data = extract_json(response_text)

        if supabase and user_id:
            try:
                supabase.table("creations").insert({
                    "user_id": user_id,
                    "type": "presentation",
                    "prompt": req.prompt,
                    "title": data.get("title", "Untitled"),
                    "output": data,
                }).execute()
            except Exception as e:
                logger.error("Failed to save presentation for user %s: %s", user_id, e)

        return data

    except Exception as e:
        logger.exception("Presentation generation failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate/report")
@limiter.limit("3/day")
async def generate_report(req: ReportRequest, request: Request, user_id: Optional[str] = Depends(verify_token)):
    try:
        section_count = {"short": "4-5", "medium": "6-8", "long": "9-12"}.get(req.length, "6-8")

        prompt = f"""You are an expert analyst and report writer.
Write a comprehensive, authoritative {req.report_type} report on the topic below.

REQUIREMENTS:
- Tone: {req.tone}
- Length: {section_count} sections
- Include executive summary, body sections, conclusion, and recommendations

TOPIC: {req.prompt}

Return ONLY valid JSON (no markdown fences) matching this schema exactly.
CRITICAL: Do NOT use HTML tags (like <h1>) or Markdown inside JSON values. Use plain text only!
{{
  "title": "...",
  "subtitle": "...",
  "report_type": "{req.report_type}",
  "date": "May 2025",
  "executive_summary": "3-4 sentence summary of the entire report...",
  "key_highlights": [
    {{"label": "...", "value": "..."}}
  ],
  "sections": [
    {{
      "heading": "...",
      "content": "Multiple detailed paragraphs of substantive content...",
      "key_points": ["...", "..."],
      "subsections": [
        {{"heading": "...", "content": "..."}}
      ]
    }}
  ],
  "conclusion": "Strong concluding paragraph...",
  "recommendations": ["Actionable recommendation 1", "...", "..."]
}}"""

        response_text = generate_with_groq(prompt, req.model_name)
        data = extract_json(response_text)

        if supabase and user_id:
            try:
                supabase.table("creations").insert({
                    "user_id": user_id,
                    "type": "report",
                    "prompt": req.prompt,
                    "title": data.get("title", "Untitled"),
                    "output": data,
                }).execute()
            except Exception as e:
                logger.error("Failed to save report for user %s: %s", user_id, e)

        return data

    except Exception as e:
        logger.exception("Report generation failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/export/pptx")
async def export_pptx(req: ExportRequest):
    try:
        from pptx import Presentation
        from pptx.dml.color import RGBColor
        from pptx.enum.text import PP_ALIGN
        from pptx.util import Inches, Pt

        data = req.presentation_data
        theme = data.get("theme", "dark")

        THEMES = {
            "dark":      {"bg": (0x0F,0x0F,0x23), "bg2": (0x1A,0x1A,0x35), "acc": (0x6C,0x63,0xFF), "acc2": (0xFF,0x65,0x84), "txt": (0xF0,0xF0,0xFF), "txt2": (0xA0,0xA0,0xC0)},
            "ocean":     {"bg": (0x07,0x14,0x28), "bg2": (0x0D,0x20,0x40), "acc": (0x00,0xC6,0xFB), "acc2": (0x00,0x5B,0xEA), "txt": (0xE0,0xF4,0xFF), "txt2": (0xC0,0xE8,0xFF)},
            "sunset":    {"bg": (0x1A,0x08,0x13), "bg2": (0x2D,0x10,0x20), "acc": (0xFF,0x65,0x84), "acc2": (0xFF,0x9F,0x43), "txt": (0xFF,0xF0,0xF3), "txt2": (0xFF,0xD0,0xD8)},
            "emerald":   {"bg": (0x02,0x14,0x08), "bg2": (0x04,0x1F,0x0F), "acc": (0x00,0xC9,0xA7), "acc2": (0x00,0xE6,0x76), "txt": (0xE0,0xFF,0xF2), "txt2": (0xA0,0xFF,0xD0)},
            "corporate": {"bg": (0xF4,0xF6,0xFB), "bg2": (0xE8,0xEC,0xF5), "acc": (0x25,0x63,0xEB), "acc2": (0x7C,0x3A,0xED), "txt": (0x11,0x18,0x27), "txt2": (0x4B,0x55,0x63)},
        }
        TC  = THEMES.get(theme, THEMES["dark"])
        BG  = RGBColor(*TC["bg"])
        BG2 = RGBColor(*TC["bg2"])
        ACC = RGBColor(*TC["acc"])
        ACC2= RGBColor(*TC["acc2"])
        TXT = RGBColor(*TC["txt"])
        TXT2= RGBColor(*TC["txt2"])

        prs = Presentation()
        prs.slide_width  = Inches(13.33)
        prs.slide_height = Inches(7.5)
        blank = prs.slide_layouts[6]

        def add_rect(slide, x, y, w, h, color):
            s = slide.shapes.add_shape(1, x, y, w, h)
            s.fill.solid()
            s.fill.fore_color.rgb = color
            s.line.fill.background()
            return s

        def add_text(slide, text, x, y, w, h, size, bold=False, color=None, italic=False, align=PP_ALIGN.LEFT):
            if not color: color = TXT
            box = slide.shapes.add_textbox(x, y, w, h)
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.text = str(text)
            p.font.size = Pt(size)
            p.font.bold = bold
            p.font.italic = italic
            p.font.color.rgb = color
            p.alignment = align

        def set_bg(slide):
            slide.background.fill.solid()
            slide.background.fill.fore_color.rgb = BG
            add_rect(slide, Inches(0), Inches(0), Inches(13.33), Inches(0.08), ACC)
            add_rect(slide, Inches(0), Inches(7.3), Inches(13.33), Inches(0.2), BG2)

        async def fetch_image(title: str):
            """Fetch a Pollinations AI image in a thread so the event loop isn't blocked."""
            encoded_prompt = urllib.parse.quote(
                f"high quality presentation slide image about {title}, professional, cinematic lighting"
            )
            url = f"https://image.pollinations.ai/prompt/{encoded_prompt}?width=1280&height=720&nologo=true"

            def _fetch():
                try:
                    r = requests.get(url, timeout=12)
                    if r.status_code == 200:
                        return io.BytesIO(r.content)
                except Exception as e:
                    logger.warning("Image fetch failed for '%s': %s", title, e)
                return None

            return await asyncio.to_thread(_fetch)

        slides = data.get("slides", [])
        total  = len(slides)

        # Fetch all images concurrently instead of one-by-one
        slide_images = await asyncio.gather(
            *[fetch_image(sd.get("title", "")) for sd in slides]
        )

        for idx, sd in enumerate(slides):
            slide = prs.slides.add_slide(blank)
            set_bg(slide)
            stype     = sd.get("type", "content")
            title_txt = sd.get("title", "")
            img_data  = slide_images[idx]

            add_text(slide, f"{idx+1} / {total}", Inches(0.4), Inches(7.1), Inches(1.4), Inches(0.3),
                     10, color=TXT2, align=PP_ALIGN.LEFT)

            if stype == "title":
                if img_data:
                    try:
                        slide.shapes.add_picture(img_data, Inches(7.0), Inches(0), Inches(6.33), Inches(7.5))
                        add_rect(slide, Inches(6.9), Inches(0), Inches(0.2), Inches(7.5), ACC)
                    except Exception:
                        pass

                add_text(slide, title_txt, Inches(0.7), Inches(2.0), Inches(6.0), Inches(2.6),
                         48, bold=True, color=TXT)
                sub = sd.get("subtitle", "")
                if sub:
                    add_text(slide, sub, Inches(0.7), Inches(4.7), Inches(6.0), Inches(1.4),
                             22, color=TXT2)

            elif stype == "quote":
                if img_data:
                    try:
                        slide.shapes.add_picture(img_data, Inches(7.5), Inches(1.0), Inches(5.0), Inches(5.5))
                    except Exception:
                        pass

                add_text(slide, "“", Inches(0.6), Inches(1.0), Inches(2), Inches(1.5),
                         100, bold=True, color=RGBColor(0x35,0x35,0x65))
                add_text(slide, sd.get("quote",""), Inches(0.8), Inches(2.2), Inches(6.2), Inches(3.5),
                         26, italic=True, color=TXT)
                add_rect(slide, Inches(0.8), Inches(5.7), Inches(1.5), Inches(0.05), ACC)
                add_text(slide, f"— {sd.get('author','')}", Inches(0.8), Inches(5.85), Inches(6.0), Inches(0.7),
                         18, bold=True, color=ACC)

            elif stype == "stats":
                if img_data:
                    try:
                        slide.shapes.add_picture(img_data, Inches(0), Inches(0), Inches(13.33), Inches(7.5))
                        add_rect(slide, Inches(0), Inches(0), Inches(13.33), Inches(7.5), RGBColor(0,0,0))
                        slide.shapes[-1].fill.transparency = 0.75
                    except Exception:
                        pass

                add_text(slide, title_txt, Inches(0.5), Inches(0.5), Inches(12), Inches(0.85),
                         38, bold=True, color=TXT, align=PP_ALIGN.CENTER)
                add_rect(slide, Inches(5.66), Inches(1.4), Inches(2.0), Inches(0.06), ACC)

                stats = sd.get("stats", [])
                n     = max(len(stats), 1)
                col_w = 12.2 / n
                for i, st in enumerate(stats[:4]):
                    x = Inches(0.55 + i * col_w)
                    w = Inches(col_w - 0.15)
                    add_text(slide, st.get("value",""), x, Inches(2.8), w, Inches(1.5),
                             54, bold=True, color=ACC, align=PP_ALIGN.CENTER)
                    add_text(slide, st.get("label",""), x, Inches(4.4), w, Inches(0.65),
                             20, bold=True, color=TXT, align=PP_ALIGN.CENTER)

            else:  # content / agenda / conclusion / image
                bullets = sd.get("bullets", sd.get("items", []))
                if not bullets and sd.get("caption"):
                    bullets = [sd.get("caption")]

                layout_style = idx % 3

                if layout_style == 0:
                    add_rect(slide, Inches(0), Inches(0.08), Inches(0.12), Inches(7.22), ACC2)
                    add_text(slide, title_txt, Inches(0.4), Inches(0.2), Inches(6.5), Inches(0.9), 32, bold=True, color=TXT)
                    add_rect(slide, Inches(0.4), Inches(1.2), Inches(2.0), Inches(0.06), ACC)
                    if img_data:
                        try: slide.shapes.add_picture(img_data, Inches(7.5), Inches(1.0), Inches(5.33), Inches(5.5))
                        except Exception: pass
                    cx, cw = Inches(0.5), Inches(6.5)

                elif layout_style == 1:
                    add_rect(slide, Inches(13.21), Inches(0.08), Inches(0.12), Inches(7.22), ACC2)
                    add_text(slide, title_txt, Inches(6.5), Inches(0.2), Inches(6.5), Inches(0.9), 32, bold=True, color=TXT)
                    add_rect(slide, Inches(6.5), Inches(1.2), Inches(2.0), Inches(0.06), ACC)
                    if img_data:
                        try: slide.shapes.add_picture(img_data, Inches(0.5), Inches(1.0), Inches(5.33), Inches(5.5))
                        except Exception: pass
                    cx, cw = Inches(6.5), Inches(6.5)

                else:
                    if img_data:
                        try:
                            slide.shapes.add_picture(img_data, Inches(0), Inches(0), Inches(13.33), Inches(7.5))
                            add_rect(slide, Inches(0), Inches(0), Inches(13.33), Inches(7.5), RGBColor(0,0,0))
                            slide.shapes[-1].fill.transparency = 0.82
                        except Exception:
                            pass
                    add_rect(slide, Inches(0), Inches(0.08), Inches(0.12), Inches(7.22), ACC2)
                    add_text(slide, title_txt, Inches(0.4), Inches(0.2), Inches(12.0), Inches(0.9), 36, bold=True, color=TXT)
                    add_rect(slide, Inches(0.4), Inches(1.2), Inches(2.0), Inches(0.06), ACC)
                    cx, cw = Inches(0.5), Inches(12.0)

                for i, b in enumerate(bullets):
                    y = Inches(1.6 + i * 0.95)
                    if y > Inches(6.5): break
                    add_rect(slide, cx, y + Inches(0.15), Inches(0.1), Inches(0.1), ACC)
                    add_text(slide, b, cx + Inches(0.22), y, cw - Inches(0.22), Inches(0.9), 16, color=TXT)

        buf = io.BytesIO()
        prs.save(buf)
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            headers={"Content-Disposition": 'attachment; filename="lumina_presentation.pptx"'},
        )

    except Exception as e:
        logger.exception("PPTX export failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/upload/document")
@limiter.limit("10/minute")
async def upload_document(request: Request, file: UploadFile = File(...)):
    """Extract text from PDF / DOCX / TXT for use as a generation prompt."""
    try:
        content = await file.read()
        text = ""
        name = (file.filename or "").lower()

        if name.endswith(".pdf"):
            import pdfplumber
            with pdfplumber.open(io.BytesIO(content)) as pdf:
                for page in pdf.pages:
                    text += (page.extract_text() or "") + "\n"
        elif name.endswith(".docx"):
            from docx import Document
            doc = Document(io.BytesIO(content))
            text = "\n".join(p.text for p in doc.paragraphs)
        else:
            text = content.decode("utf-8", errors="ignore")

        return {"text": smart_truncate(text), "filename": file.filename}
    except Exception as e:
        logger.exception("Document upload failed for file: %s", file.filename)
        raise HTTPException(status_code=500, detail=str(e))


from fastapi.staticfiles import StaticFiles
frontend_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
