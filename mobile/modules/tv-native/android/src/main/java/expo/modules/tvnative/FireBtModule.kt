package expo.modules.tvnative

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

// Faz o celular se apresentar à Firestick como um teclado + controle de mídia Bluetooth (perfil HID).
// Precisa do Android 9+; alguns fabricantes desligam esse perfil, por isso o JS consulta isSupported().
@SuppressLint("MissingPermission")
class FireBtModule : Module() {
  private var hid: BluetoothHidDevice? = null
  private var host: BluetoothDevice? = null
  private var registered = false
  private var pendingRegister: Promise? = null
  private var scanReceiver: BroadcastReceiver? = null
  private var bondReceiver: BroadcastReceiver? = null
  private val executor = Executors.newSingleThreadExecutor()

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("App ainda não está pronto")

  private val adapter: BluetoothAdapter?
    get() = (appContext.reactContext?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  // Relatório 1: teclado (modificadores + 6 teclas). Relatório 2: controle de consumo (uma tecla de 16 bits).
  private val descriptor = intArrayOf(
    0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01,
    0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
    0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,
    0xC0,
    0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x02,
    0x15, 0x00, 0x26, 0xFF, 0x03, 0x19, 0x00, 0x2A, 0xFF, 0x03, 0x75, 0x10, 0x95, 0x01, 0x81, 0x00,
    0xC0,
  ).map { it.toByte() }.toByteArray()

  private val callback = object : BluetoothHidDevice.Callback() {
    override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, isRegistered: Boolean) {
      registered = isRegistered
      pendingRegister?.let { if (isRegistered) it.resolve(true) else it.reject("ERR_BT_REGISTER", "O Bluetooth recusou o modo controle", null) }
      pendingRegister = null
      if (isRegistered && pluggedDevice != null) hid?.connect(pluggedDevice)
    }

    override fun onConnectionStateChanged(device: BluetoothDevice, state: Int) {
      host = if (state == BluetoothProfile.STATE_CONNECTED) device else if (device == host) null else host
      val label = when (state) {
        BluetoothProfile.STATE_CONNECTED -> "connected"
        BluetoothProfile.STATE_CONNECTING -> "connecting"
        else -> "disconnected"
      }
      sendEvent("onState", mapOf("state" to label, "name" to (device.name ?: ""), "address" to device.address))
    }
  }

  private fun deviceMap(d: BluetoothDevice) = mapOf(
    "name" to (d.name ?: ""),
    "address" to d.address,
    "bonded" to (d.bondState == BluetoothDevice.BOND_BONDED),
  )

  override fun definition() = ModuleDefinition {
    Name("FireBt")
    Events("onState", "onDevice", "onBond")

    Function("isSupported") {
      return@Function Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && adapter != null
    }

    Function("isEnabled") {
      return@Function adapter?.isEnabled == true
    }

    Function("requestEnable") {
      val activity = appContext.currentActivity ?: return@Function false
      activity.startActivity(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
      return@Function true
    }

    // A Firestick só acha o celular em "Adicionar dispositivo Bluetooth" se ele estiver visível.
    Function("requestDiscoverable") { seconds: Int ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.startActivity(Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, seconds))
      return@Function true
    }

    Function("bondedDevices") {
      return@Function adapter?.bondedDevices?.map { deviceMap(it) } ?: emptyList<Map<String, Any>>()
    }

    Function("startScan") {
      val a = adapter ?: return@Function false
      if (scanReceiver == null) {
        scanReceiver = object : BroadcastReceiver() {
          override fun onReceive(c: Context, intent: Intent) {
            val device: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33) {
              intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            } else {
              @Suppress("DEPRECATION") intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            }
            if (device != null) sendEvent("onDevice", deviceMap(device))
          }
        }
        context.registerReceiver(scanReceiver, IntentFilter(BluetoothDevice.ACTION_FOUND))
      }
      if (a.isDiscovering) a.cancelDiscovery()
      return@Function a.startDiscovery()
    }

    Function("stopScan") {
      adapter?.cancelDiscovery()
      scanReceiver?.let { runCatching { context.unregisterReceiver(it) } }
      scanReceiver = null
    }

    // Registra o celular como controle. Precisa acontecer antes do pareamento para a Firestick ver o perfil.
    AsyncFunction("register") { promise: Promise ->
      if (registered) return@AsyncFunction promise.resolve(true)
      val a = adapter ?: return@AsyncFunction promise.reject("ERR_BT", "Este celular não tem Bluetooth", null)
      pendingRegister = promise
      val ok = a.getProfileProxy(context, object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
          val device = proxy as BluetoothHidDevice
          hid = device
          val sdp = BluetoothHidDeviceAppSdpSettings("Controle da TV", "Controle remoto pelo celular", "tv-pai", BluetoothHidDevice.SUBCLASS1_KEYBOARD, descriptor)
          if (!device.registerApp(sdp, null, null, executor, callback)) {
            pendingRegister?.reject("ERR_BT_REGISTER", "O Bluetooth deste celular não aceita o modo controle", null)
            pendingRegister = null
          }
        }

        override fun onServiceDisconnected(profile: Int) {
          hid = null
          registered = false
        }
      }, BluetoothProfile.HID_DEVICE)
      if (!ok) {
        pendingRegister = null
        promise.reject("ERR_BT_UNSUPPORTED", "Este celular não suporta o modo controle Bluetooth", null)
      }
    }

    // Pareia a partir do celular, com o endereço Bluetooth que o app leu da TV pela rede.
    // Quando o pareamento termina, já conecta o modo controle.
    Function("pair") { address: String ->
      val a = adapter ?: return@Function false
      val device = a.getRemoteDevice(address.uppercase())
      if (device.bondState == BluetoothDevice.BOND_BONDED) return@Function hid?.connect(device) == true
      if (bondReceiver == null) {
        bondReceiver = object : BroadcastReceiver() {
          override fun onReceive(c: Context, intent: Intent) {
            val d: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33) {
              intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            } else {
              @Suppress("DEPRECATION") intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            }
            d ?: return
            val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE)
            val label = when (state) {
              BluetoothDevice.BOND_BONDED -> "bonded"
              BluetoothDevice.BOND_BONDING -> "bonding"
              else -> "none"
            }
            sendEvent("onBond", mapOf("address" to d.address, "name" to (d.name ?: ""), "state" to label))
            if (state == BluetoothDevice.BOND_BONDED) hid?.connect(d)
          }
        }
        context.registerReceiver(bondReceiver, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED))
      }
      a.cancelDiscovery()
      return@Function device.createBond()
    }

    Function("connect") { address: String ->
      val device = adapter?.getRemoteDevice(address) ?: return@Function false
      return@Function hid?.connect(device) == true
    }

    Function("disconnect") {
      host?.let { hid?.disconnect(it) }
    }

    Function("connectedHost") {
      return@Function host?.let { deviceMap(it) }
    }

    // kind "kb": código de tecla do teclado (com modificador); kind "cc": código de controle de consumo.
    AsyncFunction("sendKey") { kind: String, code: Int, modifier: Int ->
      val h = hid ?: throw IllegalStateException("Modo controle Bluetooth não iniciado")
      val target = host ?: throw IllegalStateException("A Firestick não está conectada por Bluetooth")
      if (kind == "kb") {
        h.sendReport(target, 1, byteArrayOf(modifier.toByte(), 0, code.toByte(), 0, 0, 0, 0, 0))
        h.sendReport(target, 1, ByteArray(8))
      } else {
        h.sendReport(target, 2, byteArrayOf((code and 0xFF).toByte(), ((code shr 8) and 0xFF).toByte()))
        h.sendReport(target, 2, ByteArray(2))
      }
    }

    OnDestroy {
      runCatching { adapter?.cancelDiscovery() }
      scanReceiver?.let { r -> appContext.reactContext?.let { runCatching { it.unregisterReceiver(r) } } }
      bondReceiver?.let { r -> appContext.reactContext?.let { runCatching { it.unregisterReceiver(r) } } }
      hid?.let { runCatching { it.unregisterApp() }; adapter?.closeProfileProxy(BluetoothProfile.HID_DEVICE, it) }
      executor.shutdown()
    }
  }
}
