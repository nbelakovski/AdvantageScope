# Copyright (c) 2021-2026 Littleton Robotics
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by a BSD
# license that can be found in the LICENSE file
# at the root directory of this project.

import http.server
import mimetypes
import shutil
import socketserver
import os
import sys
import json
import urllib
import gzip
import zipfile

from multipart import parse_options_header, MultipartParser

PORT = 5808
ROOT = os.path.abspath("static")
IS_SYSTEMCORE = os.uname().nodename == "robot"
EXTRA_ASSETS_PATH = "/home/systemcore/ascope_assets" if IS_SYSTEMCORE else os.path.abspath("ascope_assets")
BUNDLED_ASSETS_PATH = os.path.join(ROOT, "bundledAssets")
ALLOWED_LOG_SUFFIXES = [".wpilog", ".wpilogxz", ".rlog", ".log"]  # Hoot not supported
ENABLE_FILESYSTEM_ACCESS = IS_SYSTEMCORE or "--enable-file-access" in sys.argv
WEBROOT = ""


class Handler(http.server.SimpleHTTPRequestHandler):
    def _send_response_with_compression(self, status_code, content_type, source_data):
        """Sends a response, compressing it with gzip if the client supports it."""
        use_gzip = "gzip" in self.headers.get("Accept-Encoding", "")

        if use_gzip:
            data = gzip.compress(source_data)
            content_length = len(data)
        else:
            data = source_data
            content_length = len(source_data)

        self.send_response(status_code)
        self.send_header("Content-type", content_type)
        self.send_header("Content-Length", str(content_length))
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()

        self.wfile.write(data)

    def do_GET(self):
        request = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(request.query)

        # Don't serve directly since all assets are available under "/assets"
        if request.path.startswith(WEBROOT + "/bundledAssets"):
            self.send_error(404, "File not found.")

        # Serve list of asset files
        elif request.path == WEBROOT + "/assets" or request.path == WEBROOT + "/assets/":
            asset_file_list = {}
            for root in [BUNDLED_ASSETS_PATH, EXTRA_ASSETS_PATH]:
                for dirpath, _, filenames in os.walk(root):
                    for filename in filenames:
                        if not filename.startswith("."):
                            path = os.path.join(dirpath, filename)
                            contents = None
                            if filename == "config.json":
                                try:
                                    with open(path, "r") as f:
                                        contents = json.load(f)
                                except:
                                    pass
                            asset_file_list[os.path.relpath(path, root)] = contents
            json_string = json.dumps(asset_file_list, separators=(',', ':'))
            self._send_response_with_compression(200, "application/json", json_string.encode('utf-8'))

        # Serve asset files (bundled or extra)
        elif request.path.startswith(WEBROOT + "/assets"):
            asset_path = urllib.parse.unquote(self.path[len(WEBROOT + "/assets/"):])
            extra_asset_path = os.path.join(EXTRA_ASSETS_PATH, asset_path)
            bundled_asset_path = os.path.join(BUNDLED_ASSETS_PATH, asset_path)
            for path in [extra_asset_path, bundled_asset_path]:
                if os.path.exists(path) and os.path.isfile(path):
                    try:
                        with open(path, 'rb') as f:
                            file_content = f.read()
                            mimetype, _ = mimetypes.guess_type(path)
                            if not mimetype:
                                mimetype = 'application/octet-stream'
                            self._send_response_with_compression(200, mimetype, file_content)
                    except Exception as e:
                        self.send_error(500, f"Error serving file: {e}")
                    return
            self.send_error(404, "File not found")

        # Serve log file
        elif request.path.startswith(WEBROOT + "/logs"):
            if ENABLE_FILESYSTEM_ACCESS and "folder" in query and len(query["folder"]) > 0:
                filename = urllib.parse.unquote(request.path[len(WEBROOT + "/logs/"):])
                if any(filename.endswith(suffix) for suffix in ALLOWED_LOG_SUFFIXES):
                    full_path = os.path.join(query["folder"][0], filename)
                    if os.path.exists(full_path):
                        try:
                            with open(full_path, 'rb') as f:
                                file_content = f.read()
                                self._send_response_with_compression(200, "application/octet-stream", file_content)
                        except Exception as e:
                            self.send_error(500, f"Error serving file: {e}")
                        return
            self.send_error(404, "File not found")

        # Generate presigned URL for log upload to DigitalOcean Spaces
        elif request.path == WEBROOT + "/www/upload-log-url":
            print("Received request for upload URL")
            do_key = os.environ.get("DO_SPACES_KEY")
            do_secret = os.environ.get("DO_SPACES_SECRET")
            do_region = os.environ.get("DO_SPACES_REGION")
            do_bucket = os.environ.get("DO_SPACES_BUCKET")

            if not all([do_key, do_secret, do_region, do_bucket]):
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Cloud upload not configured. Set DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_REGION, and DO_SPACES_BUCKET environment variables.")
                return

            filename = query.get("filename", ["log.wpilog"])[0]
            # Sanitize: keep only the basename to prevent path traversal
            filename = os.path.basename(filename)
            filename = f"Tribecbot/Champs/{filename}"

            try:
                import boto3
                from botocore.config import Config as BotocoreConfig

                s3 = boto3.client(
                    "s3",
                    region_name=do_region,
                    endpoint_url=f"https://{do_region}.digitaloceanspaces.com",
                    aws_access_key_id=do_key,
                    aws_secret_access_key=do_secret,
                    config=BotocoreConfig(signature_version="s3v4")
                )
                presigned_url = s3.generate_presigned_url(
                    "put_object",
                    Params={
                        "Bucket": do_bucket,
                        "Key": filename,
                        "ContentType": "application/octet-stream"
                    },
                    ExpiresIn=900  # 15 minutes
                )
                json_string = json.dumps({"url": presigned_url}, separators=(',', ':'))
                self._send_response_with_compression(200, "application/json", json_string.encode("utf-8"))
            except ImportError:
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"boto3 is required for cloud upload. Run: pip install boto3")
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"Failed to generate upload URL: {e}".encode("utf-8"))

        # List all log files from DigitalOcean Spaces under Tribecbot/ (recursive)
        elif request.path == WEBROOT + "/cloud-browse" or request.path == WEBROOT + "/cloud-browse/":
            do_key = os.environ.get("DO_SPACES_KEY")
            do_secret = os.environ.get("DO_SPACES_SECRET")
            do_region = os.environ.get("DO_SPACES_REGION")
            do_bucket = os.environ.get("DO_SPACES_BUCKET")

            if not all([do_key, do_secret, do_region, do_bucket]):
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Cloud logs not configured. Set DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_REGION, and DO_SPACES_BUCKET environment variables.")
                return

            try:
                import boto3
                from botocore.config import Config as BotocoreConfig

                s3 = boto3.client(
                    "s3",
                    region_name=do_region,
                    endpoint_url=f"https://{do_region}.digitaloceanspaces.com",
                    aws_access_key_id=do_key,
                    aws_secret_access_key=do_secret,
                    config=BotocoreConfig(signature_version="s3v4")
                )
                CLOUD_PREFIX = "Tribecbot/"
                paginator = s3.get_paginator("list_objects_v2")
                files = []
                for page in paginator.paginate(Bucket=do_bucket, Prefix=CLOUD_PREFIX):
                    for obj in page.get("Contents", []):
                        key = obj["Key"]
                        # relative path from Tribecbot/
                        rel = key[len(CLOUD_PREFIX):]
                        # skip folder placeholder entries (end with /)
                        if not rel or rel.endswith("/"):
                            continue
                        if any(rel.endswith(suffix) for suffix in ALLOWED_LOG_SUFFIXES):
                            files.append({"key": rel, "size": obj["Size"]})
                json_string = json.dumps(files, separators=(',', ':'))
                self._send_response_with_compression(200, "application/json", json_string.encode("utf-8"))
            except ImportError:
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"boto3 is required for cloud logs. Run: pip install boto3")
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"Failed to list cloud logs: {e}".encode("utf-8"))

        # Check if a log filename exists in Tribecbot/Champs/
        elif request.path == WEBROOT + "/cloud-exists" or request.path == WEBROOT + "/cloud-exists/":
            do_key = os.environ.get("DO_SPACES_KEY")
            do_secret = os.environ.get("DO_SPACES_SECRET")
            do_region = os.environ.get("DO_SPACES_REGION")
            do_bucket = os.environ.get("DO_SPACES_BUCKET")

            if not all([do_key, do_secret, do_region, do_bucket]):
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Cloud logs not configured.")
                return

            filename = query.get("filename", [""])[0]
            filename = os.path.basename(filename)
            if not filename or not any(filename.endswith(suffix) for suffix in ALLOWED_LOG_SUFFIXES):
                self.send_error(400, "Invalid filename")
                return

            target_key = f"Tribecbot/Champs/{filename}"

            try:
                import boto3
                from botocore.config import Config as BotocoreConfig

                s3 = boto3.client(
                    "s3",
                    region_name=do_region,
                    endpoint_url=f"https://{do_region}.digitaloceanspaces.com",
                    aws_access_key_id=do_key,
                    aws_secret_access_key=do_secret,
                    config=BotocoreConfig(signature_version="s3v4")
                )

                response = s3.list_objects_v2(Bucket=do_bucket, Prefix=target_key, MaxKeys=1)
                exists = any(obj.get("Key") == target_key for obj in response.get("Contents", []))
                json_string = json.dumps({"exists": exists}, separators=(',', ':'))
                self._send_response_with_compression(200, "application/json", json_string.encode("utf-8"))
            except ImportError:
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"boto3 is required for cloud logs. Run: pip install boto3")
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"Failed to check cloud log existence: {e}".encode("utf-8"))

        # Generate a presigned URL for direct log download from DigitalOcean Spaces
        elif request.path.startswith(WEBROOT + "/cloud-log-url/"):
            do_key = os.environ.get("DO_SPACES_KEY")
            do_secret = os.environ.get("DO_SPACES_SECRET")
            do_region = os.environ.get("DO_SPACES_REGION")
            do_bucket = os.environ.get("DO_SPACES_BUCKET")

            if not all([do_key, do_secret, do_region, do_bucket]):
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Cloud logs not configured.")
                return

            raw_rel = urllib.parse.unquote(request.path[len(WEBROOT + "/cloud-log-url/"):])
            # Sanitize: disallow empty paths, path traversal components, and non-log extensions
            if not raw_rel or ".." in raw_rel.split("/") or not any(raw_rel.endswith(suffix) for suffix in ALLOWED_LOG_SUFFIXES):
                self.send_error(400, "Invalid log path")
                return

            key = f"Tribecbot/{raw_rel}"
            filename = os.path.basename(raw_rel)
            response_disposition = query.get("response-content-disposition", [""])[0]
            if response_disposition == "":
                response_disposition = f'attachment; filename="{filename}"'
            try:
                import boto3
                from botocore.config import Config as BotocoreConfig

                s3 = boto3.client(
                    "s3",
                    region_name=do_region,
                    endpoint_url=f"https://{do_region}.digitaloceanspaces.com",
                    aws_access_key_id=do_key,
                    aws_secret_access_key=do_secret,
                    config=BotocoreConfig(signature_version="s3v4")
                )
                presigned_url = s3.generate_presigned_url(
                    "get_object",
                    Params={
                        "Bucket": do_bucket,
                        "Key": key,
                        "ResponseContentType": "application/octet-stream",
                        "ResponseContentDisposition": response_disposition
                    },
                    ExpiresIn=900
                )
                json_string = json.dumps({"url": presigned_url}, separators=(',', ':'))
                self._send_response_with_compression(200, "application/json", json_string.encode("utf-8"))
            except ImportError:
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"boto3 is required for cloud logs. Run: pip install boto3")
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"Failed to generate cloud log URL: {e}".encode("utf-8"))

        # Backward-compatible endpoint: redirect to a presigned URL instead of proxying bytes
        elif request.path.startswith(WEBROOT + "/cloud-log/"):
            do_key = os.environ.get("DO_SPACES_KEY")
            do_secret = os.environ.get("DO_SPACES_SECRET")
            do_region = os.environ.get("DO_SPACES_REGION")
            do_bucket = os.environ.get("DO_SPACES_BUCKET")

            if not all([do_key, do_secret, do_region, do_bucket]):
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Cloud logs not configured.")
                return

            raw_rel = urllib.parse.unquote(request.path[len(WEBROOT + "/cloud-log/"):])
            if not raw_rel or ".." in raw_rel.split("/") or not any(raw_rel.endswith(suffix) for suffix in ALLOWED_LOG_SUFFIXES):
                self.send_error(400, "Invalid log path")
                return

            key = f"Tribecbot/{raw_rel}"
            filename = os.path.basename(raw_rel)
            try:
                import boto3
                from botocore.config import Config as BotocoreConfig

                s3 = boto3.client(
                    "s3",
                    region_name=do_region,
                    endpoint_url=f"https://{do_region}.digitaloceanspaces.com",
                    aws_access_key_id=do_key,
                    aws_secret_access_key=do_secret,
                    config=BotocoreConfig(signature_version="s3v4")
                )
                presigned_url = s3.generate_presigned_url(
                    "get_object",
                    Params={
                        "Bucket": do_bucket,
                        "Key": key,
                        "ResponseContentType": "application/octet-stream",
                        "ResponseContentDisposition": f'attachment; filename="{filename}"'
                    },
                    ExpiresIn=900
                )
                self.send_response(307)
                self.send_header("Location", presigned_url)
                self.end_headers()
            except ImportError:
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"boto3 is required for cloud logs. Run: pip install boto3")
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"Failed to generate cloud log redirect: {e}".encode("utf-8"))

        # Serve everything else
        else:
            filepath = self.translate_path(self.path.removeprefix(WEBROOT))
            if os.path.isdir(filepath):
                index_path = os.path.join(filepath, "index.html")
                if os.path.exists(index_path):
                    filepath = index_path
                else:
                    self.send_error(404, f"File not found: {self.path}")
                    return

            if os.path.exists(filepath) and os.path.isfile(filepath):
                try:
                    with open(filepath, "rb") as f:
                        file_content = f.read()
                        mimetype, _ = mimetypes.guess_type(filepath)
                        if not mimetype:
                            mimetype = "application/octet-stream"
                        self._send_response_with_compression(200, mimetype, file_content)
                except Exception as e:
                    self.send_error(500, f"Error serving file: {e}")
            else:
                self.send_error(404, f"File not found: {self.path}")

    def do_POST(self):
        request = urllib.parse.urlparse(self.path)
        if request.path.startswith(WEBROOT + "/uploadAsset") & ENABLE_FILESYSTEM_ACCESS:
            content_type, options = parse_options_header(self.headers.get("Content-Type", ""))

            if content_type == "multipart/form-data" and 'boundary' in options:
                stream = self.rfile
                boundary = options["boundary"]
                parser = MultipartParser(stream, boundary, content_length=int(self.headers.get("Content-Length", -1)))

                for part in parser:
                    if part.filename:
                        if part.filename.lower().endswith(".zip"):
                            asset_zip = f"{EXTRA_ASSETS_PATH}/{part.filename}"
                            part.save_as(asset_zip)
                            temp_path = EXTRA_ASSETS_PATH + "/AS_TEMP/"
                            asset_path = temp_path + part.filename[:-len(".zip")]  # remove .zip ending

                            with zipfile.ZipFile(asset_zip, "r") as zip_ref:
                                zip_ref.extractall(asset_path)
                                os.remove(asset_zip)

                            # recursively extract .zips
                            for dirpath, _, filenames in os.walk(asset_path):
                                for filename in filenames:
                                    if filename.lower().endswith(".zip"):
                                        with zipfile.ZipFile(f"{dirpath}/{filename}", "r") as zip_ref:
                                            filename_no_ext = filename[:-4]  # remove .zip (4 char)
                                            zip_ref.extractall(f"{dirpath}/{filename_no_ext}")
                                            os.remove(f"{dirpath}/{filename}")
                            # find config folders
                            for dirpath, _, filenames in os.walk(asset_path):
                                for filename in filenames:
                                    if filename == "config.json":
                                        # recursively copy the parent directory to extra assets, overwriting existing files
                                        dirname = os.path.basename(dirpath)
                                        shutil.copytree(dirpath, f"{EXTRA_ASSETS_PATH}/{dirname}", dirs_exist_ok=True)
                            shutil.rmtree(temp_path)

                            self.send_response(200)
                            self.end_headers()
                        else:
                            self.send_response(400, "Uploaded asset must be a zip")
                            self.end_headers()

                # Free up resources after use
                for part in parser.parts():
                    part.close()
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    # Create extra assets folder
    if not os.path.exists(EXTRA_ASSETS_PATH):
        os.mkdir(EXTRA_ASSETS_PATH)
        print(f"Created folder for extra assets: {EXTRA_ASSETS_PATH}")

    # Warn if filesystem access disabled
    if not ENABLE_FILESYSTEM_ACCESS:
        print("Log downloads and custom asset uploads are currently disabled. Pass \"--enable-file-access\" to override.\nWARNING: When enabled, AdvantageScope Lite provides unrestricted access to all log files on the host filesystem and upload access to the ascope_assets folder.\n")

    # Start server
    os.chdir(ROOT)
    httpd = socketserver.ThreadingTCPServer(("", PORT), Handler, bind_and_activate=False)
    httpd.allow_reuse_address = True
    httpd.daemon_threads = True
    print(f"Serving AdvantageScope Lite on port {PORT}: http://localhost:{PORT}{WEBROOT}")
    try:
        httpd.server_bind()
        httpd.server_activate()
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
        httpd.server_close()
        print("\nServer stopped")
