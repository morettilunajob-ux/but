import os
import shutil
import tempfile

from fastapi import FastAPI, UploadFile, File, HTTPException
from faster_whisper import WhisperModel


MODEL_NAME = os.getenv(
    "WHISPER_MODEL",
    "small"
)


print(
    f"🎤 Carregando Whisper local: {MODEL_NAME}"
)


model = WhisperModel(
    MODEL_NAME,
    device="cpu",
    compute_type="int8"
)


print(
    "✅ Whisper carregado e pronto."
)


app = FastAPI()


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_NAME
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...)
):

    suffix = ".ogg"


    if file.filename:
        extension =
        os.path.splitext(file.filename)[1]

        if extension:
            suffix = extension


    temp_path = None


    try:

        fd, temp_path =
            tempfile.mkstemp(
                suffix=suffix
            )


        os.close(fd)


        with open(
            temp_path,
            "wb"
        ) as output:

            shutil.copyfileobj(
                file.file,
                output
            )


        segments, info =
            model.transcribe(
                temp_path,
                language="pt",
                beam_size=5,
                vad_filter=True,
                temperature=0
            )


        texto = " ".join(
            segment.text.strip()
            for segment in segments
            if segment.text.strip()
        ).strip()


        if not texto:
            raise HTTPException(
                status_code=422,
                detail="Nenhuma fala foi detectada."
            )


        return {
            "text": texto,
            "language": info.language,
            "duration": info.duration
        }


    except HTTPException:
        raise


    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )


    finally:

        if (
            temp_path and
            os.path.exists(temp_path)
        ):

            try:
                os.remove(
                    temp_path
                )
            except Exception:
                pass