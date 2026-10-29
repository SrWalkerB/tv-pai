package expo.modules.tvnative

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

// HTTP(S) para a API de controle remoto da Fire TV (porta 8080). Ela usa um certificado próprio,
// autoassinado, que o Android recusa por padrão. Em vez de aceitar qualquer um, fixamos o certificado
// no primeiro pareamento (trust-on-first-use): o JS guarda a impressão digital SHA-256 junto com o
// token do PIN, e depois disso qualquer certificado diferente é recusado. Só endereços da rede local.
class TvHttpModule : Module() {
  // Valida contra o certificado fixado (se houver) e anota a impressão digital vista.
  private class PinningTrust(private val pinned: String?) : X509TrustManager {
    var seen: String? = null
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
      val leaf = chain.firstOrNull() ?: throw CertificateException("A TV não apresentou certificado")
      val fp = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
      seen = fp
      if (pinned != null && !pinned.equals(fp, ignoreCase = true)) {
        throw CertificateException("O certificado da TV mudou: pode ser outro aparelho se passando por ela")
      }
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
  }

  // Com o certificado já fixado, reaproveita a mesma fábrica TLS: assim a conexão fica aberta entre
  // as teclas (keep-alive) em vez de refazer o aperto de mão a cada toque.
  private val pinnedFactories = mutableMapOf<String, javax.net.ssl.SSLSocketFactory>()

  private fun factoryFor(trust: PinningTrust, pin: String?): javax.net.ssl.SSLSocketFactory {
    val make = { SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), SecureRandom()) }.socketFactory }
    if (pin == null) return make()
    return synchronized(pinnedFactories) { pinnedFactories.getOrPut(pin.lowercase(), make) }
  }

  private fun isLocal(host: String): Boolean {
    val addr = runCatching { InetAddress.getByName(host) }.getOrNull() ?: return false
    return addr.isSiteLocalAddress || addr.isLinkLocalAddress
  }

  override fun definition() = ModuleDefinition {
    Name("TvHttp")

    // pin: impressão digital SHA-256 fixada para esse host (null só durante o primeiro pareamento).
    AsyncFunction("request") { method: String, url: String, headers: Map<String, String>, body: String?, timeoutMs: Int, pin: String? ->
      val u = URL(url)
      if (!isLocal(u.host)) throw IllegalArgumentException("Só é permitido falar com aparelhos da rede local")
      val trust = PinningTrust(pin)
      val conn = u.openConnection() as HttpURLConnection
      if (conn is HttpsURLConnection) {
        conn.sslSocketFactory = factoryFor(trust, pin)
        // O certificado autoassinado da TV não traz o IP como nome; quem garante a identidade é o pin acima.
        conn.setHostnameVerifier { _, _ -> true }
      }
      conn.requestMethod = method
      conn.connectTimeout = timeoutMs
      conn.readTimeout = timeoutMs
      headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
      // POST sempre com Content-Length explícito (mesmo vazio): sem ele, o servidor da Fire TV fica
      // esperando um corpo que nunca chega e o comando estoura o tempo.
      if (method != "GET") {
        val bytes = (body ?: "").toByteArray(Charsets.UTF_8)
        conn.doOutput = true
        conn.setFixedLengthStreamingMode(bytes.size)
        conn.outputStream.use { it.write(bytes) }
      }
      val status = conn.responseCode
      val stream = if (status >= 400) conn.errorStream else conn.inputStream
      // Lê tudo e fecha só o fluxo (sem disconnect): assim o Android devolve a conexão ao pool e a
      // próxima tecla reaproveita o TLS já aberto, em vez de refazer o aperto de mão (~0,5 s na Firestick).
      val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
      return@AsyncFunction mapOf("status" to status, "body" to text, "fingerprint" to trust.seen)
    }
  }
}
