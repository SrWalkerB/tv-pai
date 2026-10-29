package expo.modules.tvnative

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Acha Fire TVs na rede pelo anúncio mDNS que elas fazem (_amzn-wplay._tcp), com o nome de verdade
// ("Fire TV de Walker") no campo TXT "n". Evita o usuário ter que descobrir e digitar o IP.
class TvDiscoveryModule : Module() {
  private var listener: NsdManager.DiscoveryListener? = null
  private var multicastLock: WifiManager.MulticastLock? = null

  private val nsd: NsdManager?
    get() = appContext.reactContext?.getSystemService(Context.NSD_SERVICE) as? NsdManager

  private fun stopDiscovery() {
    listener?.let { runCatching { nsd?.stopServiceDiscovery(it) } }
    listener = null
    multicastLock?.let { if (it.isHeld) it.release() }
    multicastLock = null
  }

  @Suppress("DEPRECATION")
  private fun resolve(manager: NsdManager, info: NsdServiceInfo) {
    manager.resolveService(info, object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}

      override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
        val host = serviceInfo.host?.hostAddress ?: return
        val name = serviceInfo.attributes["n"]?.toString(Charsets.UTF_8) ?: serviceInfo.serviceName
        val model = serviceInfo.attributes["c"]?.toString(Charsets.UTF_8) ?: ""
        sendEvent("onTv", mapOf("name" to name, "host" to host, "mac" to model))
      }
    })
  }

  override fun definition() = ModuleDefinition {
    Name("TvDiscovery")
    Events("onTv")

    Function("start") {
      val manager = nsd ?: return@Function false
      stopDiscovery()
      val wifi = appContext.reactContext?.applicationContext?.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      multicastLock = wifi?.createMulticastLock("tvpai-discovery")?.apply { setReferenceCounted(false); acquire() }
      val l = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
          resolve(manager, serviceInfo)
        }
      }
      listener = l
      manager.discoverServices("_amzn-wplay._tcp.", NsdManager.PROTOCOL_DNS_SD, l)
      return@Function true
    }

    Function("stop") { stopDiscovery() }

    OnDestroy { stopDiscovery() }
  }
}
