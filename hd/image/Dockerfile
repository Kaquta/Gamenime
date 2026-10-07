# GameNime — image de la tache gn-hd (images HD de « Cette semaine »)
# Python 3.12 (l'image deja telechargee pour l'essai, figee par son empreinte)
# et des paquets a versions figees : la tache tourne toujours a l'identique.
# OpenCV 4 et pas 5 : c'est le 4 qui a encore le detecteur de visages en cascade.
# Les programmes ne sont pas dans l'image : /opt/stack/hd/app est monte au lancement.
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
# onnxruntime : pas de telemetrie (ni envoi a Microsoft, ni ecriture dans ~/.cache), des la construction
ENV ORT_DISABLE_TELEMETRY=1
RUN pip install --no-cache-dir --root-user-action=ignore --disable-pip-version-check \
      numpy==2.5.3 pillow==12.3.0 onnx==1.23.1 onnxruntime==1.30.0 opencv-python-headless==4.14.0.94 \
      protobuf==7.36.2 ml_dtypes==0.6.0 flatbuffers==25.12.19 packaging==26.3 typing_extensions==4.16.0 \
 && python -c "import cv2, onnx, onnxruntime, numpy, PIL; assert hasattr(cv2, 'CascadeClassifier'); print('gn-hd:1 OK : opencv', cv2.__version__, '| onnxruntime', onnxruntime.__version__)"
LABEL gn.tache="gn-hd" gn.version="1"
WORKDIR /app
