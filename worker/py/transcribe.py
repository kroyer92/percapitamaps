"""faster-whisper transcription with word timestamps, used to check the voiceover."""
import json, os, sys

from faster_whisper import WhisperModel


def main():
    job = json.load(sys.stdin)
    os.environ.setdefault("HF_HOME", os.path.join(job["models_dir"], "hf"))
    model = WhisperModel(job.get("model", "small.en"), device="cpu", compute_type="int8",
                         download_root=os.path.join(job["models_dir"], "whisper"))
    segments, _ = model.transcribe(job["audio"], language="en", word_timestamps=True, beam_size=1)
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"word": w.word.strip(), "start": w.start, "end": w.end})
    print(json.dumps({"words": words}))


if __name__ == "__main__":
    main()
