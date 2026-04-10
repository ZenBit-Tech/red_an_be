import logging
import os
import re
from dataclasses import dataclass
from typing import Dict, List, Pattern, Tuple

from fastapi import FastAPI
from pydantic import BaseModel, Field
from transformers import pipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("remote-nlp")

app = FastAPI(title="Remote NLP Service")

SUPPORTED_ENTITIES = {
    "FREE_TEXT",
    "HEALTH_DATA",
    "RACE",
    "RELIGION",
    "POLITICAL_VIEWS",
    "SEXUAL_LIFE",
    "SEXUAL_ORIENTATION",
}

SENSITIVE_LABEL_TO_ENTITY = {
    "race": "RACE",
    "religion": "RELIGION",
    "political views": "POLITICAL_VIEWS",
    "sexual life": "SEXUAL_LIFE",
    "sexual orientation": "SEXUAL_ORIENTATION",
}

HEALTH_KEYWORDS = [
    "diagnosis",
    "diagnosed",
    "symptom",
    "treatment",
    "medication",
    "prescription",
    "allergy",
    "oncology",
    "cardiology",
    "diabetes",
    "hypertension",
    "cancer",
    "infection",
    "medical",
    "clinical",
    "patient",
]

# Terms used for precise span extraction. These are intentionally narrower than
# context keywords to avoid over-redaction of full sentences.
HEALTH_SPAN_TERMS = [
    "diabetes",
    "hypertension",
    "cancer",
    "infection",
    "allergy",
    "asthma",
    "oncology",
    "cardiology",
    "medication",
    "prescription",
    "diagnosis",
    "diagnosed",
    "symptom",
    "treatment",
]

RELIGION_TERMS = [
    "muslim",
    "islam",
    "christian",
    "christianity",
    "catholic",
    "protestant",
    "jew",
    "jewish",
    "judaism",
    "hindu",
    "hinduism",
    "buddhist",
    "buddhism",
    "sikh",
    "sikhism",
    "atheist",
    "atheism",
    "agnostic",
]

POLITICAL_VIEWS_TERMS = [
    "left-wing",
    "right-wing",
    "conservative",
    "liberal",
    "socialist",
    "communist",
    "anarchist",
    "centrist",
    "progressive",
    "libertarian",
    "democrat",
    "republican",
    "labour",
    "tory",
]

SEXUAL_ORIENTATION_TERMS = [
    "gay",
    "lesbian",
    "bisexual",
    "heterosexual",
    "homosexual",
    "queer",
    "pansexual",
    "asexual",
]

RACE_TERMS = [
    "white",
    "black",
    "asian",
    "african",
    "caucasian",
    "latino",
    "latina",
    "hispanic",
    "arab",
    "indian",
    "native american",
    "pacific islander",
    "mixed race",
]

SEXUAL_LIFE_TERMS = [
    "sex life",
    "sexual activity",
    "sexually active",
    "sexual partner",
    "intimate partner",
    "condom use",
    "contraception",
    "pregnancy history",
]

HEALTH_PATTERN = re.compile(r"\b(" + "|".join(HEALTH_KEYWORDS) + r")\b", re.IGNORECASE)
HEALTH_SPAN_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(term) for term in HEALTH_SPAN_TERMS) + r")\b",
    re.IGNORECASE,
)
RELIGION_SPAN_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(term) for term in RELIGION_TERMS) + r")\b",
    re.IGNORECASE,
)
POLITICAL_VIEWS_SPAN_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(term) for term in POLITICAL_VIEWS_TERMS) + r")\b",
    re.IGNORECASE,
)
SEXUAL_ORIENTATION_SPAN_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(term) for term in SEXUAL_ORIENTATION_TERMS) + r")\b",
    re.IGNORECASE,
)
RACE_SPAN_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(term) for term in RACE_TERMS) + r")\b",
    re.IGNORECASE,
)
SEXUAL_LIFE_SPAN_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(term) for term in SEXUAL_LIFE_TERMS) + r")\b",
    re.IGNORECASE,
)

QUOTED_TEXT_PATTERN = re.compile(r"(?:\"([^\"\n]{3,})\")|(?:'([^'\n]{3,})')")
SENTENCE_PATTERN = re.compile(r"[^.!?]+[.!?]?", re.MULTILINE)


class AnalyzeRequest(BaseModel):
    text: str
    threshold: float = Field(default=0.85, ge=0.0, le=1.0)
    framework: str
    entities: List[str]


class RecognizerResult(BaseModel):
    start: int
    end: int
    entity_type: str
    score: float


@dataclass
class SentenceSlice:
    text: str
    start: int
    end: int


classifier = None


@app.on_event("startup")
def startup_event() -> None:
    global classifier

    model_name = os.getenv("REMOTE_NLP_MODEL", "facebook/bart-large-mnli")
    device = int(os.getenv("REMOTE_NLP_DEVICE", "-1"))

    try:
        classifier = pipeline(
            "zero-shot-classification",
            model=model_name,
            device=device,
        )
        logger.info("Loaded zero-shot model: %s", model_name)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to load zero-shot model: %s", exc)
        classifier = None


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok" if classifier is not None else "degraded"}


@app.post("/analyze", response_model=List[RecognizerResult])
def analyze(payload: AnalyzeRequest) -> List[RecognizerResult]:
    requested_entities = [
        entity_type for entity_type in payload.entities if entity_type in SUPPORTED_ENTITIES
    ]

    if not requested_entities:
        return []

    sentence_slices = split_sentences(payload.text)
    if not sentence_slices:
        return []

    threshold = payload.threshold
    default_threshold = float(os.getenv("REMOTE_NLP_DEFAULT_THRESHOLD", "0.9"))
    effective_threshold = max(threshold, default_threshold)

    results: List[RecognizerResult] = []
    for sentence in sentence_slices:
        results.extend(detect_health_entities(sentence, requested_entities, effective_threshold))
        results.extend(detect_sensitive_entities(sentence, requested_entities, effective_threshold))

    return deduplicate_results(results)


def split_sentences(text: str) -> List[SentenceSlice]:
    max_length = int(os.getenv("REMOTE_NLP_MAX_SENTENCE_LENGTH", "700"))

    sentences: List[SentenceSlice] = []
    for match in SENTENCE_PATTERN.finditer(text):
        raw_sentence_text = match.group(0)
        if not raw_sentence_text.strip():
            continue

        left_trim = len(raw_sentence_text) - len(raw_sentence_text.lstrip())
        right_trim = len(raw_sentence_text) - len(raw_sentence_text.rstrip())

        sentence_text = raw_sentence_text.strip()
        start = match.start() + left_trim
        end = match.end() - right_trim

        if len(sentence_text) > max_length:
            continue

        sentences.append(SentenceSlice(text=sentence_text, start=start, end=end))

    return sentences


def detect_health_entities(
    sentence: SentenceSlice,
    requested_entities: List[str],
    threshold: float,
) -> List[RecognizerResult]:
    findings: List[RecognizerResult] = []

    has_health_signal = bool(HEALTH_PATTERN.search(sentence.text))
    if not has_health_signal:
        return findings

    health_spans = extract_spans(sentence, HEALTH_SPAN_PATTERN)

    if not health_spans:
        return findings

    if "HEALTH_DATA" in requested_entities:
        for start, end in health_spans:
            findings.append(
                RecognizerResult(
                    start=start,
                    end=end,
                    entity_type="HEALTH_DATA",
                    score=round(max(0.9, threshold), 3),
                )
            )

    if "FREE_TEXT" in requested_entities:
        quoted_spans = extract_quoted_spans(sentence)

        for start, end in quoted_spans:
            findings.append(
                RecognizerResult(
                    start=start,
                    end=end,
                    entity_type="FREE_TEXT",
                    score=round(max(0.85, threshold), 3),
                )
            )

    return findings


def detect_sensitive_entities(
    sentence: SentenceSlice,
    requested_entities: List[str],
    threshold: float,
) -> List[RecognizerResult]:
    if classifier is None:
        return []

    candidate_labels: List[str] = []
    label_to_entity: Dict[str, str] = {}
    for label, entity_type in SENSITIVE_LABEL_TO_ENTITY.items():
        if entity_type in requested_entities:
            candidate_labels.append(label)
            label_to_entity[label] = entity_type

    if not candidate_labels:
        return []

    inference = classifier(
        sentence.text,
        candidate_labels=candidate_labels,
        multi_label=True,
    )

    results: List[RecognizerResult] = []
    labels: List[str] = inference.get("labels", [])
    scores: List[float] = inference.get("scores", [])

    for label, score in zip(labels, scores):
        if score < threshold:
            continue

        entity_type = label_to_entity.get(label)
        if entity_type is None:
            continue

        for start, end in extract_sensitive_spans(sentence, entity_type):
            results.append(
                RecognizerResult(
                    start=start,
                    end=end,
                    entity_type=entity_type,
                    score=round(float(score), 3),
                )
            )

    return results


def extract_sensitive_spans(sentence: SentenceSlice, entity_type: str) -> List[Tuple[int, int]]:
    if entity_type == "RELIGION":
        return extract_spans(sentence, RELIGION_SPAN_PATTERN)

    if entity_type == "POLITICAL_VIEWS":
        return extract_spans(sentence, POLITICAL_VIEWS_SPAN_PATTERN)

    if entity_type == "SEXUAL_ORIENTATION":
        return extract_spans(sentence, SEXUAL_ORIENTATION_SPAN_PATTERN)

    if entity_type == "RACE":
        return extract_spans(sentence, RACE_SPAN_PATTERN)

    if entity_type == "SEXUAL_LIFE":
        return extract_spans(sentence, SEXUAL_LIFE_SPAN_PATTERN)

    return []


def extract_spans(sentence: SentenceSlice, pattern: Pattern[str]) -> List[Tuple[int, int]]:
    spans: List[Tuple[int, int]] = []
    for match in pattern.finditer(sentence.text):
        start = sentence.start + match.start()
        end = sentence.start + match.end()

        if start < end:
            spans.append((start, end))

    return spans


def extract_quoted_spans(sentence: SentenceSlice) -> List[Tuple[int, int]]:
    spans: List[Tuple[int, int]] = []
    for match in QUOTED_TEXT_PATTERN.finditer(sentence.text):
        quoted_group = match.group(1) if match.group(1) is not None else match.group(2)

        if not quoted_group:
            continue

        local_start = match.start(1) if match.group(1) is not None else match.start(2)
        local_end = local_start + len(quoted_group)

        start = sentence.start + local_start
        end = sentence.start + local_end
        if start < end:
            spans.append((start, end))

    return spans


def deduplicate_results(results: List[RecognizerResult]) -> List[RecognizerResult]:
    unique: Dict[Tuple[int, int, str], RecognizerResult] = {}
    for item in results:
        key = (item.start, item.end, item.entity_type)
        existing = unique.get(key)

        if existing is None or item.score > existing.score:
            unique[key] = item

    return sorted(unique.values(), key=lambda item: (item.start, item.end, item.entity_type))
