# CAAIS Middleware

## Develop NginX configuration

```ini
location /správa-registrací/ {
  auth_request /authenticate;
  proxy_pass http://nkd-registration-manager:5100/;

  auth_request_set $caais_token $upstream_http_x_caais_token;
  proxy_set_header x-caais-token $caais_token;
}

location = /authenticate {
  internal;
  proxy_pass http://nkd-caais-middleware:5000/authenticate;

  # Do not pass the body content.
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";

  # Set headers to pass to authorization service.
  proxy_set_header Host             $host;
  proxy_set_header X-Real-IP        $remote_addr;
  proxy_set_header X-Forwarded-Uri  $request_uri;

  # Caching.
  # proxy_cache auth_cache;
  # proxy_cache_key "$http_authorization";
  # proxy_cache_valid 200 30s;

  # Timeout.
  proxy_next_upstream error timeout http_500;
  error_page 500 = 503;
}

error_page 401 = @login_redirect;
location @login_redirect {
  return 302 /caais/login?redirect-url=$request_uri;
}

location /caais/ {
  proxy_pass http://nkd-caais-middleware:5000/;

  # Set headers to pass to authorization service.
  proxy_set_header Host             $host;
  proxy_set_header X-Real-IP        $remote_addr;
  proxy_set_header X-Forwarded-Uri  $request_uri;
}
```

## skoda NginX configuration

See https://skoda.projekty.ms.mff.cuni.cz/správa-registrací/

```ini
location /správa-registrací/ {
  auth_request /authenticate;
  proxy_pass http://127.0.0.1:5100/;

  auth_request_set $caais_token $upstream_http_x_caais_token;
  proxy_set_header x-caais-token $caais_token;
}

location = /authenticate {
  internal;
  proxy_pass http://127.0.0.1:5000/authenticate;

  # Do not pass the body content.
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";

  # Set headers to pass to authorization service.
  proxy_set_header Host             $host;
  proxy_set_header X-Real-IP        $remote_addr;
  proxy_set_header X-Forwarded-Uri  $request_uri;

  # Caching.
  # proxy_cache auth_cache;
  # proxy_cache_key "$http_authorization";
  # proxy_cache_valid 200 30s;

  # Timeout.
  proxy_next_upstream error timeout http_500;
  error_page 500 = 503;
}

error_page 401 = @login_redirect;
location @login_redirect {
  return 302 /caais/login?redirect-url=$request_uri;
}

location /caais/ {
  proxy_pass http://127.0.0.1:5000/;

  # Set headers to pass to authorization service.
  proxy_set_header Host             $host;
  proxy_set_header X-Real-IP        $remote_addr;
  proxy_set_header X-Forwarded-Uri  $request_uri;
}
```

## [Deprecated] NginX configuration

```ini

location /protected {
  auth_request /authenticate;
  # error_page 401 =403 /auth/sign_in;

  proxy_pass http://caais-demo:3000/protected;
  proxy_pass_request_headers on;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_intercept_errors on;

  # Pass authorization requests.
  auth_request_set $user $upstream_http_x_auth_request_user;
  auth_request_set $token $upstream_http_x_access_token;
  proxy_set_header X-User $user;
  proxy_set_header Authorization "Bearer $token";
}

location = /authenticate {
  # Available only to internal requests.
  internal;
  proxy_pass http://caais-middleware:5000/authenticate;

  # Do not pass the body content.
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";

  # Set headers to pass to authorization service.
  proxy_set_header Host             $host;
  proxy_set_header X-Real-IP        $remote_addr;
  proxy_set_header X-Forwarded-Uri  $request_uri;

  # Caching.
  proxy_cache auth_cache;
  proxy_cache_key "$http_authorization";
  proxy_cache_valid 200 30s;

  # Timeout.
  proxy_next_upstream error timeout http_500;
  error_page 500 = 503;
}
```
