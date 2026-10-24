"""What a technician with full hands hears: one /chat answer turned into a short spoken text, and what they
say back matched to the option it means. Plain functions, tested without any API."""

import re

MAX_SENTENCES = 2
MAX_WORDS = 35  # a safety net; spoken turns also ask the agent for one short sentence
ON_MAP = "It's on your map."
DIDNT_GET_IT = "Sorry, I didn't catch that. Could you say it again?"

DIGITS = "zero one two three four five six seven eight nine".split()
NUMBER_WORDS = {
    "zero": "0", "ground": "0", "one": "1", "first": "1", "1st": "1", "two": "2", "second": "2", "2nd": "2",
    "three": "3", "third": "3", "3rd": "3", "four": "4", "fourth": "4", "4th": "4", "five": "5", "fifth": "5",
}
ORDINALS = {"first": 0, "second": 1, "third": 2, "fourth": 3}

# a room number after a name ("Office 1.04", "Desk 2.03-B"), not a measurement ("12.50 m")
ROOM_REF = re.compile(r"(?<=[A-Za-zÄÖÜäöüß] )(-?\d{1,2})\.(\d{2,3})(?:-([A-Z]))?\b(?!\s*(?:m\b|m²|%))")
METRES = re.compile(r"(\d+(?:\.\d+)?)\s?m\b(?!²)")
A_METRES = re.compile(r"\b([Aa]n?) (\d+(?:\.\d+)?)\s?m\b(?!²)")  # "a 145 m walk" -> "a 145-metre walk"
SQUARE_METRES = re.compile(r"(\d+(?:\.\d+)?)\s?(?:m²|m2\b|sqm\b)")
FILLER_START = re.compile(r"^(?:sure|okay|ok|got it|great|alright|of course|good question|no problem)\b[!.,]?\s*",
                          re.IGNORECASE)
# ", and I've put a pin on it on your map" / " and the route is on your map": we say ON_MAP once instead
MAP_CLAUSE = re.compile(r"(?:,\s*|\s+)(?:and|so)?\s*[^,.!?]*\bmap\b[^,.!?]*", re.IGNORECASE)


# ---------- what the agent said -> what we say ----------

def plain(text: str) -> str:
    """Markdown and lists to running sentences."""
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)  # links
    text = re.sub(r"[*_`#>]+", "", text)
    lines = []
    for line in text.splitlines():
        line = re.sub(r"^\s*(?:[-•]|\d+[.)])\s+", "", line).strip()
        if line:
            lines.append(line if line[-1] in ".!?:;," else line + ".")
    return " ".join(lines)


def say_room_ref(match: re.Match) -> str:
    floor, number, letter = match.groups()
    words = (["minus"] if floor.startswith("-") else []) + [DIGITS[int(d)] for d in floor.lstrip("-") + number]
    return " ".join(words + ([letter] if letter else []))


def amount(number: str, unit: str) -> str:
    """Whole numbers from 10 up ("143 metres"), one decimal below ("1.1 metres"), "1 metre"."""
    value = float(number)
    value = round(value) if value >= 10 else round(value, 1)
    shown = f"{value:g}"
    return f"{shown} {unit}" if shown == "1" else f"{shown} {unit}s"


def say_numbers(text: str) -> str:
    """Room numbers digit by digit, distances rounded, units as words."""
    text = SQUARE_METRES.sub(lambda m: amount(m.group(1), "square metre"), text)
    text = A_METRES.sub(lambda m: f"{m.group(1)} {amount(m.group(2), 'metre')[:-1].replace(' ', '-')}", text)
    text = METRES.sub(lambda m: amount(m.group(1), "metre"), text)
    text = ROOM_REF.sub(say_room_ref, text)
    text = re.sub(r"\s*\(([^()]+)\)", r", \1", text)  # "Office 1.04 (Floor 1)" -> "Office ..., Floor 1"
    return re.sub(r"\s+", " ", text).strip()


def sentences(text: str) -> list[str]:
    return [part for part in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])", text) if part.strip()]


def without_map_talk(sentence: str) -> str:
    if "map" not in sentence.lower():
        return sentence
    trimmed = MAP_CLAUSE.sub("", sentence).strip()
    if not trimmed or "map" in trimmed.lower() or len(trimmed.split()) < 3:
        return ""  # the whole sentence was about the map
    return trimmed if trimmed[-1] in ".!?" else trimmed + "."


def short(reply: str) -> str:
    """At most two sentences and about 35 words (always the first sentence), no filler, no map talk."""
    kept: list[str] = []
    only_filler = None  # "Sure." on its own is still an answer, unless the rest was map talk
    map_talk = False
    for sentence in sentences(plain(reply)):
        cleaned = FILLER_START.sub("", sentence).strip()
        if not cleaned:
            only_filler = only_filler or sentence
            continue
        sentence = without_map_talk(cleaned)
        if not sentence:
            map_talk = True
            continue
        if kept and len(" ".join(kept + [sentence]).split()) > MAX_WORDS:
            break
        kept.append(sentence[0].upper() + sentence[1:])
        if len(kept) == MAX_SENTENCES:
            break
    return " ".join(kept) or ("" if map_talk else only_filler or "")


def options_phrase(labels: list[str]) -> str:
    """["Ground floor", "Floor 1"] -> "Ground floor, or Floor 1?" """
    if len(labels) == 1:
        return f"{labels[0]}?"
    return ", ".join(labels[:-1]) + f", or {labels[-1]}?"


def speakable(text: str) -> str:
    """Any text the app wants said (no shortening): markdown out, room numbers and units as words."""
    return say_numbers(plain(text))


def spoken_text(answer: dict) -> str:
    """One /chat answer {reply, question, map} as the words to speak. When the agent asks back, only the
    question and its options: the reply before it is lead-up ("There are 7 coffee machines...")."""
    question = answer.get("question")
    if question:
        parts = [question["question"].strip(),
                 options_phrase([option["label"] for option in question.get("options", [])])]
    else:
        reply = short(answer.get("reply") or "")
        parts = [reply] if reply else []
        if shows_something(answer.get("map")):
            parts.append(ON_MAP)
    return say_numbers(" ".join(parts)) if parts else DIDNT_GET_IT


def shows_something(map_view: dict | None) -> bool:
    return bool(map_view and (map_view.get("route") or map_view.get("target")))


# ---------- what the person said -> what we send ----------

def keyterms(building: dict) -> list[str]:
    """Names worth listening for in one building (GET /buildings/{id}), most useful first: floors, kinds of
    things ("coordinate measuring machine"), room names with numbers, lifts and stairs."""
    terms = [floor["name"] for floor in building.get("floors", [])]
    terms += sorted({asset["type"].replace("_", " ") for asset in building.get("assets", []) if asset.get("type")})
    terms += [space["name"] for space in building.get("spaces", [])
              if space.get("name") and space.get("type") in ("room", "hall")]
    terms += [connector["name"] for connector in building.get("vertical_connectors", []) if connector.get("name")]
    return list(dict.fromkeys(term for term in terms if term))


def words(text: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9äöüß]+", text.lower().replace("'", ""))
    return [NUMBER_WORDS.get(token, token) for token in tokens]


def match_option(transcript: str, options: list[dict]) -> str:
    """The option label the person means ("first floor" -> "Floor 1"), or the transcript unchanged.

    An option matches when every word of its label was said; with several matches the longest label wins,
    and a tie means we can't tell, so the agent gets the person's own words."""
    said = set(words(transcript))
    best: list[tuple[int, str]] = []
    for option in options:
        label_words = set(words(option["label"]))
        if label_words and label_words <= said:
            best.append((len(label_words), option["label"]))
    if best:
        best.sort(reverse=True)
        if len(best) == 1 or best[0][0] > best[1][0]:
            return best[0][1]
        return transcript
    picked = re.fullmatch(r"(?:the\s+)?(first|second|third|fourth|last)(?:\s+(?:one|option))?",
                          transcript.strip().lower().rstrip(".!"))
    if picked and options:
        index = -1 if picked.group(1) == "last" else ORDINALS[picked.group(1)]
        if index < len(options):
            return options[index]["label"]
    return transcript
