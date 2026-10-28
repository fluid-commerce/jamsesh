// The local relay a joined Mac shows the session through.
//
// The JamSesh window loads http://127.0.0.1:<port>, which WebKit treats as a secure origin, so the
// microphone, camera and audio worklets work even when the host is a plain-http address on the
// room's Wi-Fi. Every request and WebSocket is relayed to the host with this device's token, and
// the token the host hands out when this Mac pairs is kept (in the Keychain, by the caller).
use std::convert::Infallible;
use std::sync::{Arc, RwLock};

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Request, Response, StatusCode, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};

type Body = BoxBody<Bytes, hyper::Error>;
type HttpsClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, Incoming>;

/// Where the host is: `http://192.168.1.20:4747` or `https://jam.duckdns.org`.
#[derive(Clone, Debug)]
pub struct Upstream {
    pub origin: String,
    pub host: String,
    pub port: u16,
    pub tls: bool,
}

impl Upstream {
    pub fn parse(input: &str) -> Result<Self, String> {
        let raw = input.trim().trim_end_matches('/');
        let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
        let url = url::Url::parse(&with_scheme).map_err(|_| format!("“{raw}” isn't an address."))?;
        let tls = match url.scheme() {
            "https" => true,
            "http" => false,
            _ => return Err("Use an http or https address.".into()),
        };
        let host = url.host_str().ok_or("That address has no host name.")?.to_string();
        let port = url.port().unwrap_or(if tls { 443 } else if raw.contains("://") { 80 } else { 4747 });
        let default_port = if tls { 443 } else { 80 };
        let origin = if port == default_port { format!("{}://{host}", url.scheme()) } else { format!("{}://{host}:{port}", url.scheme()) };
        Ok(Self { origin, host, port, tls })
    }
}

struct Shared {
    up: Upstream,
    local: String,
    /// The person's credential, for the app's own window.
    token: RwLock<Option<String>>,
    /// This Mac's agents' credential: can't approve builds or speak as a person.
    agents: RwLock<Option<String>>,
    client: HttpsClient,
    tls: Arc<rustls::ClientConfig>,
    on_token: Box<dyn Fn(String) + Send + Sync>,
}

pub struct Proxy {
    pub port: u16,
    shared: Arc<Shared>,
    stop: tokio::sync::watch::Sender<bool>,
}

impl Proxy {
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
    pub fn set_agents_token(&self, token: Option<String>) {
        if let Ok(mut t) = self.shared.agents.write() {
            *t = token;
        }
    }
    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }

    /// Mirrors one of the host's dev-server ports at 127.0.0.1:<port> on this Mac, so a dev tile in
    /// the window can keep its port. Requests carry this Mac's token, which the host's dev ports
    /// accept. Over the public address the host routes dev servers by name (dev-<port>.<host>).
    /// Fails if this Mac already uses that port.
    pub async fn mirror(&self, port: u16) -> Result<Proxy, String> {
        let up = &self.shared.up;
        let dev = if up.tls {
            let host = format!("dev-{port}.{}", up.host);
            Upstream { origin: format!("https://{host}"), host, port: 443, tls: true }
        } else {
            Upstream { origin: format!("http://{}:{port}", up.host), host: up.host.clone(), port, tls: false }
        };
        let token = self.shared.token.read().ok().and_then(|t| t.clone());
        bind(dev, token, None, port, true, |_| {}).await
    }
}

fn tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

/// Starts the relay on `preferred_port` (so the window keeps the same origin, and with it its saved
/// state, across launches), or on any free port if that one is taken.
pub async fn start(up: Upstream, token: Option<String>, agents: Option<String>, preferred_port: u16, on_token: impl Fn(String) + Send + Sync + 'static) -> Result<Proxy, String> {
    bind(up, token, agents, preferred_port, false, on_token).await
}

/// `exact`: only `preferred_port` will do (a dev-port mirror); otherwise any free port is the fallback.
async fn bind(up: Upstream, token: Option<String>, agents: Option<String>, preferred_port: u16, exact: bool, on_token: impl Fn(String) + Send + Sync + 'static) -> Result<Proxy, String> {
    let listener = match TcpListener::bind(("127.0.0.1", preferred_port)).await {
        Ok(l) => l,
        Err(e) if exact => return Err(format!("Port {preferred_port} is in use on this Mac: {e}")),
        Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Couldn't open the local relay: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let tls = tls_config()?;
    let connector = hyper_rustls::HttpsConnectorBuilder::new().with_tls_config((*tls).clone()).https_or_http().enable_http1().build();
    let client: HttpsClient = Client::builder(TokioExecutor::new()).build(connector);
    let shared = Arc::new(Shared { up, local: format!("127.0.0.1:{port}"), token: RwLock::new(token), agents: RwLock::new(agents), client, tls, on_token: Box::new(on_token) });
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let sh = shared.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let sh = sh.clone();
                    tokio::spawn(async move {
                        let svc = hyper::service::service_fn(move |req| handle(sh.clone(), req));
                        let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).with_upgrades().await;
                    });
                }
            }
        }
    });
    Ok(Proxy { port, shared, stop })
}

fn text(status: StatusCode, msg: &str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(msg.to_string())).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

async fn handle(sh: Arc<Shared>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    Ok(match forward(&sh, req).await {
        Ok(r) => r,
        Err(e) => text(StatusCode::BAD_GATEWAY, &format!("JamSesh can't reach the host at {}: {e}", sh.up.origin)),
    })
}

const HOP: [&str; 6] = ["connection", "keep-alive", "proxy-connection", "te", "trailer", "upgrade"];

fn prepare(sh: &Shared, headers: &mut HeaderMap, upgrade: bool, path: &str) {
    if !upgrade {
        for h in HOP {
            headers.remove(h);
        }
    }
    headers.remove(header::HOST);
    // Links the host builds (the canvas relay, redirects) come back through this relay. Agent setup
    // is the exception: agents must reach the host directly, not this Mac's relay.
    if !path.starts_with("/agent/") {
        if let Ok(v) = HeaderValue::from_str(&sh.local) {
            headers.insert("x-forwarded-host", v);
        }
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
    }
    // Agents set up through the app send no credentials (or an empty "Bearer"): add this Mac's.
    let empty = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).is_none_or(|v| v.trim().eq_ignore_ascii_case("bearer") || v.trim().is_empty());
    if empty {
        // The app's window is a browser page (it sends Origin and Sec-Fetch headers); anything else
        // on this Mac talking to the relay is an agent and gets the agents' credential.
        let window = headers.contains_key("sec-fetch-mode") || headers.contains_key(header::ORIGIN);
        let pick = if window { &sh.token } else { &sh.agents };
        if let Some(t) = pick.read().ok().and_then(|t| t.clone()) {
            if let Ok(v) = HeaderValue::from_str(&format!("Bearer {t}")) {
                headers.insert(header::AUTHORIZATION, v);
            }
        }
    }
}

fn rewrite_response(sh: &Shared, headers: &mut HeaderMap, upgraded: bool) {
    let cookies: Vec<HeaderValue> = headers.get_all(header::SET_COOKIE).iter().cloned().collect();
    if !cookies.is_empty() {
        headers.remove(header::SET_COOKIE);
        for c in cookies {
            let Ok(s) = c.to_str() else { continue };
            if let Some(rest) = s.strip_prefix("jam_token=") {
                let tok = rest.split(';').next().unwrap_or("").trim().to_string();
                if !tok.is_empty() {
                    if let Ok(mut t) = sh.token.write() {
                        *t = Some(tok.clone());
                    }
                    (sh.on_token)(tok);
                }
            }
            // The window's origin is this relay: drop the host's domain scope and https-only flag.
            let cleaned = s
                .split(';')
                .map(str::trim)
                .filter(|p| {
                    let l = p.to_ascii_lowercase();
                    !l.starts_with("domain=") && l != "secure"
                })
                .collect::<Vec<_>>()
                .join("; ");
            if let Ok(v) = HeaderValue::from_str(&cleaned) {
                headers.append(header::SET_COOKIE, v);
            }
        }
    }
    if let Some(loc) = headers.get(header::LOCATION).and_then(|l| l.to_str().ok()).map(str::to_string) {
        if let Some(rest) = loc.strip_prefix(&sh.up.origin) {
            if let Ok(v) = HeaderValue::from_str(&format!("http://{}{rest}", sh.local)) {
                headers.insert(header::LOCATION, v);
            }
        }
    }
    headers.remove(header::STRICT_TRANSPORT_SECURITY);
    if !upgraded {
        headers.remove(header::CONNECTION);
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

async fn connect(sh: &Shared) -> Result<Box<dyn Io>, String> {
    let tcp = TcpStream::connect((sh.up.host.as_str(), sh.up.port)).await.map_err(|e| e.to_string())?;
    if !sh.up.tls {
        return Ok(Box::new(tcp));
    }
    let name = rustls::pki_types::ServerName::try_from(sh.up.host.clone()).map_err(|e| e.to_string())?;
    let tls = tokio_rustls::TlsConnector::from(sh.tls.clone()).connect(name, tcp).await.map_err(|e| e.to_string())?;
    Ok(Box::new(tls))
}

async fn forward(sh: &Shared, mut req: Request<Incoming>) -> Result<Response<Body>, String> {
    let path = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    let upgrade = req.headers().contains_key(header::UPGRADE);

    if upgrade {
        // WebSockets (the live session, the canvas): open a dedicated connection and splice it.
        let down = hyper::upgrade::on(&mut req);
        let (mut parts, _) = req.into_parts();
        prepare(sh, &mut parts.headers, true, &path);
        let host = if (sh.up.tls && sh.up.port == 443) || (!sh.up.tls && sh.up.port == 80) { sh.up.host.clone() } else { format!("{}:{}", sh.up.host, sh.up.port) };
        parts.headers.insert(header::HOST, HeaderValue::from_str(&host).map_err(|e| e.to_string())?);
        parts.uri = path.parse::<Uri>().map_err(|e| e.to_string())?;
        let up_req = Request::from_parts(parts, Empty::<Bytes>::new());
        let io = connect(sh).await?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io)).await.map_err(|e| e.to_string())?;
        tokio::spawn(conn.with_upgrades());
        let mut resp = sender.send_request(up_req).await.map_err(|e| e.to_string())?;
        let switched = resp.status() == StatusCode::SWITCHING_PROTOCOLS;
        if switched {
            let up = hyper::upgrade::on(&mut resp);
            tokio::spawn(async move {
                if let (Ok(u), Ok(d)) = (up.await, down.await) {
                    let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(u), &mut TokioIo::new(d)).await;
                }
            });
        }
        let (mut parts, body) = resp.into_parts();
        rewrite_response(sh, &mut parts.headers, switched);
        return Ok(Response::from_parts(parts, body.boxed()));
    }

    let uri: Uri = format!("{}{path}", sh.up.origin).parse().map_err(|e: hyper::http::uri::InvalidUri| e.to_string())?;
    let (mut parts, body) = req.into_parts();
    prepare(sh, &mut parts.headers, false, &path);
    parts.uri = uri;
    let resp = sh.client.request(Request::from_parts(parts, body)).await.map_err(|e| e.to_string())?;
    let (mut parts, body) = resp.into_parts();
    rewrite_response(sh, &mut parts.headers, false);
    Ok(Response::from_parts(parts, body.boxed()))
}

/// GET a path through the relay (so the token is added). For small JSON and scripts.
pub async fn get(proxy_port: u16, path: &str) -> Result<(StatusCode, String), String> {
    let client = Client::builder(TokioExecutor::new()).build_http::<Empty<Bytes>>();
    let uri: Uri = format!("http://127.0.0.1:{proxy_port}{path}").parse().map_err(|e: hyper::http::uri::InvalidUri| e.to_string())?;
    let resp = tokio::time::timeout(std::time::Duration::from_secs(4), client.get(uri)).await.map_err(|_| "timed out".to_string())?.map_err(|e| e.to_string())?;
    let status = resp.status();
    let bytes = resp.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
}

/// Whether something answers JamSesh's health check at `origin` (direct, not through a relay).
pub async fn healthy(origin: &str) -> bool {
    let Ok(up) = Upstream::parse(origin) else { return false };
    let Ok(tls) = tls_config() else { return false };
    let connector = hyper_rustls::HttpsConnectorBuilder::new().with_tls_config((*tls).clone()).https_or_http().enable_http1().build();
    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build(connector);
    let Ok(uri) = format!("{}/healthz", up.origin).parse::<Uri>() else { return false };
    matches!(tokio::time::timeout(std::time::Duration::from_secs(3), client.get(uri)).await, Ok(Ok(r)) if r.status().is_success())
}

/// POST to the host directly (not through a relay), optionally as a paired device. For small JSON.
pub async fn post(origin: &str, path: &str, bearer: Option<&str>) -> Result<String, String> {
    let tls = tls_config()?;
    let connector = hyper_rustls::HttpsConnectorBuilder::new().with_tls_config((*tls).clone()).https_or_http().enable_http1().build();
    let client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new()).build(connector);
    let mut req = Request::post(format!("{origin}{path}")).header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let req = req.body(Full::new(Bytes::from_static(b"{}"))).map_err(|e| e.to_string())?;
    let resp = tokio::time::timeout(std::time::Duration::from_secs(8), client.request(req)).await.map_err(|_| "timed out".to_string())?.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{}", resp.status()));
    }
    let bytes = resp.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
