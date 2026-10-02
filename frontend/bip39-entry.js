import {entropyToMnemonic, mnemonicToEntropy} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';

self.VylkBIP39 = {entropyToMnemonic, mnemonicToEntropy, wordlist};
