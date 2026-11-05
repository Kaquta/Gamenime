# GameNime - image de la tache gn-apercu (la vitre animee de l'apercu du lien dans Discord), 29 octobre 2026.
# Python 3.12 : la meme image de depart que gn-hd:1 (deja sur le serveur), figee par son empreinte.
# Playwright et son Chromium sans ecran (avec ses bibliotheques et ses polices), ffmpeg et gifsicle ; paquets Python a
# versions figees : la tache tourne toujours a l'identique.
# Les programmes ne sont pas dans l'image : /opt/stack/apercu/app est monte au lancement.
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PYTHONDONTWRITEBYTECODE=1 DEBIAN_FRONTEND=noninteractive
RUN pip install --no-cache-dir --root-user-action=ignore --disable-pip-version-check \
      playwright==1.56.0 greenlet==3.5.6 pyee==13.0.1 typing_extensions==4.16.0 numpy==2.5.3 pillow==12.3.0 \
 && python -m playwright install --with-deps --only-shell chromium \
 && apt-get install -y --no-install-recommends ffmpeg gifsicle \
 && rm -rf /var/lib/apt/lists/* /root/.cache \
 && chmod -R a+rX /ms-playwright \
 && python -c "import playwright, numpy, PIL; print('gn-apercu:1 : paquets OK')"
LABEL gn.tache="gn-apercu" gn.version="1"
WORKDIR /app
