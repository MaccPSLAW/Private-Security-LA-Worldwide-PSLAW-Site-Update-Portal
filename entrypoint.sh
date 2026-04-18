#!/usr/bin/env sh
set -eu

python manage.py migrate --noinput
python manage.py collectstatic --noinput

exec gunicorn portal.wsgi:application --config gunicorn.conf.py
