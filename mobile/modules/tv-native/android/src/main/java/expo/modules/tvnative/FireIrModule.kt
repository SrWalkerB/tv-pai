package expo.modules.tvnative

import android.content.Context
import android.hardware.ConsumerIrManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Ponte mínima para o emissor de infravermelho (ConsumerIrManager) que celulares Xiaomi/Redmi/Poco têm.
class FireIrModule : Module() {
  private val ir: ConsumerIrManager?
    get() = appContext.reactContext?.getSystemService(Context.CONSUMER_IR_SERVICE) as? ConsumerIrManager

  override fun definition() = ModuleDefinition {
    Name("FireIr")

    Function("hasEmitter") {
      return@Function ir?.hasIrEmitter() == true
    }

    // Faixas de frequência que o emissor aceita (para diagnosticar quando a TV não responde).
    Function("carrierRanges") {
      return@Function ir?.carrierFrequencies?.map { listOf(it.minFrequency, it.maxFrequency) } ?: emptyList<List<Int>>()
    }

    // pattern: durações alternadas em microssegundos, começando com o emissor ligado.
    // Um envio de cada vez (nunca dois sinais por cima um do outro) e devolve quantos ms o emissor
    // segurou a chamada: se for bem menos que a duração do sinal, o Android está enfileirando por baixo.
    AsyncFunction("transmit") { frequency: Int, pattern: IntArray ->
      val manager = ir
      if (manager == null || !manager.hasIrEmitter()) throw IllegalStateException("Este celular não tem emissor de infravermelho")
      synchronized(this@FireIrModule) {
        val started = System.nanoTime()
        manager.transmit(frequency, pattern)
        return@AsyncFunction ((System.nanoTime() - started) / 1_000_000).toInt()
      }
    }
  }
}
