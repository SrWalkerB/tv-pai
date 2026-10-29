package expo.modules.tvnative

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec

// Chave e assinatura RSA do ADB no código nativo: em JS puro (Hermes, sem JIT) as contas de 2048 bits
// travavam o app por muito tempo.
class TvKeysModule : Module() {
  // DigestInfo do SHA-1: o adbd trata o token de 20 bytes como se já fosse o hash.
  private val sha1Prefix = byteArrayOf(
    0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
  )

  override fun definition() = ModuleDefinition {
    Name("TvKeys")

    AsyncFunction("generateRsaPem") {
      val generator = KeyPairGenerator.getInstance("RSA")
      generator.initialize(2048)
      val der = generator.generateKeyPair().private.encoded // PKCS#8
      val body = Base64.encodeToString(der, Base64.NO_WRAP).chunked(64).joinToString("\n")
      return@AsyncFunction "-----BEGIN PRIVATE KEY-----\n$body\n-----END PRIVATE KEY-----\n"
    }

    AsyncFunction("sign") { pem: String, token: ByteArray ->
      val body = pem.lines().filter { !it.startsWith("-----") }.joinToString("")
      val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(Base64.decode(body, Base64.DEFAULT)))
      val signer = Signature.getInstance("NONEwithRSA")
      signer.initSign(key)
      signer.update(sha1Prefix + token)
      return@AsyncFunction signer.sign()
    }
  }
}
